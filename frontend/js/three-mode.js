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
    // The 3D view is display only: a polygon clip that fails degrades what is drawn, and is reported
    // and counted in clipHealth() (parcel-arrangement.js) instead of being swallowed.
    function reportThreeClip(operation, error, site, operands) {
        const clips = window.__parcelArrangement;
        if (!clips || typeof clips.reportClipFailure !== 'function') throw error;
        clips.reportClipFailure(operation, error, { site: site }, operands);
    }
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
    const threeResources = (typeof window !== 'undefined') ? window.__threeResources : null;
    if (!threeResources || typeof threeResources.disposeOwnedSubtree !== 'function') {
        console.error('[3D] Three.js resource ownership helper is unavailable. Skipping 3D mode initialization.');
        return;
    }
    const buildingDisplayPolicy = (typeof window !== 'undefined') ? window.__threeBuildingDisplay : null;
    if (!buildingDisplayPolicy
        || typeof buildingDisplayPolicy.resolveBuiltDisplayPolicy !== 'function'
        || typeof buildingDisplayPolicy.resolveBuildingRenderParts !== 'function') {
        console.error('[3D] Building display policy is unavailable. Skipping 3D mode initialization.');
        return;
    }
    const buildingFacades = window.__threeBuildingFacades;
    if (!buildingFacades) {
        console.error('[3D] Procedural building facades are unavailable. Skipping 3D mode initialization.');
        return;
    }
    const facadeState = buildingFacades.createState(THREE);
    // Pitched roofs and balconies an urban rule asks for (three-rule-roofs.js).
    const ruleRoofs = window.__threeRuleRoofs.create({ THREE, coordsToXY, finishMesh: (mesh, geometry) => {
        markOwnedGeometry(mesh, geometry);
        attachBuildingDepthPrepass(mesh);
    } });
    // Lit windows at night on every building material (three-night-windows.js), through shared uniforms.
    const nightWindows = window.__threeNightWindows;
    const nightWindowState = nightWindows.createState();
    const floorPlanGeometry = window.__buildingFloorPlans;
    const floorPlanRenderer = window.__threeFloorPlans;
    if (!floorPlanGeometry || !floorPlanRenderer) {
        console.error('[3D] Floor-plan renderer is unavailable. Skipping 3D mode initialization.');
        return;
    }
    let xrayEnabled = new URLSearchParams(window.location.search).get('xray') === '1';
    let xrayButton = null;
    let xrayNote = null;
    let floorCutawayControl = null;
    let floorCutawaySelect = null;
    let floorCutawayLevel = null;
    let floorPlanGroup = null;
    let floorPlanErrors = 0;
    const renderedFloorPlanKeys = new Set();
    // Suggested default layouts (default-floor-plans.js) for proposed buildings without a modelled
    // interior: a toggle inside X-ray, planned once per parcel slice and cached, with street
    // centrelines fetched per cell so entrances face the street. Never written to any proposal.
    const suggestedFloorPlans = window.__defaultFloorPlans || null;
    const suggestedPlanContext = window.__defaultFloorPlanContext || null;
    let suggestedPlansEnabled = new URLSearchParams(window.location.search).get('suggested') === '1';
    // Typical layouts by era for the existing buildings around, inside the same toggle.
    let suggestedExistingEnabled = new URLSearchParams(window.location.search).get('suggestedExisting') === '1';
    let suggestedPlansButton = null;
    let suggestedExistingRow = null;
    let suggestedExistingCheckbox = null;
    const suggestedPlanCache = new Map();
    const suggestedStreetCells = new Map(); // cell key → { features: Feature[] | null, pending }
    const suggestedPlanTotals = { buildings: 0, slices: 0, flagged: 0, apartments: 0, cores: 0, pendingStreets: false, existing: 0, existingCapped: false };
    // What the panels say when a parcel or a proposal is clicked: per parcel the slice's result,
    // per proposal the totals over its buildings. Rebuilt with the scene.
    const suggestedPlanByParcel = new Map();
    const suggestedPlanByProposal = new Map();
    const SUGGESTED_EXISTING_CAP = 400;
    const FACADE_PREF_KEY = 'cb_3d_facades';
    const FACADE_STYLE_KEY = 'cb_3d_facade_style';
    let facadesEnabled = false;
    let facadeStyle = 'mixed';
    let facadeCheckbox = null;
    let facadeStyleSelect = null;
    let facadeNote = null;

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
    let sceneAbort = null;
    let sceneReadyPromise = null;
    let resolveSceneReady = null;
    let sceneReady = false;
    let sceneRevision = 0;
    let warmSceneKey = null;
    let warmSceneTimer = null;
    let resizeObserver = null;
    let sceneParcelSnapshot = [];
    let buildingViewDirty = false;
    let buildingWorkIncomplete = false;
    let buildingBuildPending = false;
    let buildingsWorkGeneration = 0;
    let buildingDisplaySnapshot = null;
    let renderedBuildingDisplaySnapshot = null;
    let sceneVisualRevision = 0;   // bumped when something in the scene changes (invalidateThreeView)
    let renderedSceneVisualRevision = -1;
    // When the person last touched the view (pointer, wheel, keyboard, camera). Frame hooks that only
    // decorate (people and vehicles) park themselves after LIFE_IDLE_MS without input.
    let lastInputAt = 0;
    let hooksParked = false;       // the last frame found every hook idle: the next input wakes them
    const LIFE_IDLE_MS = 20000;
    let nearbyDataScope = null;
    const WARM_SCENE_TTL_MS = 60000;
    const WARM_SCENE_MAX_BYTES = 128 * 1024 * 1024;
    const sceneWork = window.__threeSceneWork;
    const buildingRefreshQueue = sceneWork.createRefreshQueue(family => build3DBuildingFamilies(family));
    function currentSceneKey() {
        const center = map.getCenter();
        return JSON.stringify([window.CityConfigManager?.getCurrentCityId?.(),
            window.CityConfigManager?.getBuildingSourceId?.(), center.lat.toFixed(6), center.lng.toFixed(6),
            map.getZoom(), sceneRevision]);
    }
    function stopSceneWork() {
        sceneAbort?.abort();
        if (buildingRefreshQueue.pending || buildingBuildPending || pendingModelLoads > 0) buildingWorkIncomplete = true;
        buildingRefreshQueue.cancel();
        buildingsWorkGeneration++;
        buildingsRenderGeneration++;
        nearbyProposalBuildingsFetching = nearbyTreesFetching = nearbyWaterFetching = false;
    }
    let origin3857 = null; // Leaflet EPSG:3857 origin for local XY
    let sceneLoadGeometry = null; // frozen at 3D entry; panning never moves the backend query
    let sceneLoadGeometrySource = 'camera';
    let sceneTreeLoadGeometry = null; // preserves the existing tree query scope, but freezes its anchor
    let sceneTreeLoadGeometrySource = 'camera';
    let focusProposalIds = null; // Set of proposalIds to frame on 3D entry (shared-link focus), or null for all
    let renderingStatusRelease = null; // the status line's hold while 3D initialises (ephemerals.md)
    let isTransitioning3D = false; // avoid double-activation
    let buildingsLoaderRelease = null; // the status line's hold while built buildings load
    let buildingsLoaderText = '';
    let pendingModelLoads = 0; // count of uploaded glTF models still downloading

    // URL-driven entry: optionally start a gentle camera rotation until the user interacts.
    const INTRO_AUTO_ROTATE_SPEED = 0.7; // OrbitControls: ~86s per revolution (1.0 ≈ 60s)
    const INTRO_MANUAL_AUTO_ROTATE_RAD_PER_SEC = 0.18; // fallback if OrbitControls is missing
    // (No parse-time THREE usage in this file: the global arrives from the deferred ESM
    // bootstrap, so THREE may only be touched once the user actually enters a 3D flow.)
    let pendingIntroAutoRotate = false;
    let pendingRestoreView = null; // a shared render's camera pose to reproduce on entry, or null
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
    let parkGroundGroup = null;
    let squareGroundGroup = null;
    let lakeGroundGroup = null;
    let proposalGroundGroup = null;
    let parcelLayoutGroup = null;
    let parcelGroundGeneration = 0;
    let buildingGroup = null; // buildings extrusion
    let existingBuildingsGroup = null;
    let planningSourcesGroup = null;
    let proposedBuildingsGroup = null;
    let ineligibleBuildingsGroup = null;
    let parkGroup = null; // park decorations (trees)
    let squareGroup = null; // square decorations (fountains, stalls)
    let lakeGroup = null; // lake decorations (fish)
    let stationGroup = null; // placeable bus/tram/underground/elevated station models
    let existingTransitAlignmentGroup = null; // immutable tram/heavy-rail snapshot (city-gated)
    let treesGroup = null; // real-world OSM trees (Overture base/land), toggleable scenery
    let waterGroup = null; // real-world sea, lakes and rivers (OpenFreeMap tiles), toggleable scenery
    let greenGroup = null; // real-world lawns, parks, meadows and woods (OpenFreeMap tiles), toggleable scenery
    let proposalInteractionGroup = null; // selectable applied/unapplied proposal surfaces
    let proposalDraftGroup = null; // source-vs-draft comparison overlay; never mutates proposal state
    let compareUnappliedGroup = null; // what the Compare tab's plan sides draw of members not on the map; drawn in the compare passes only
    let latestProposalDraftPreviewDetail = null;
    let onMapEditorModelPreviewGeneration = 0;
    let treesEnabled = true; // user toggle (default ON); real value loaded from storage on 3D init
    let lifeGroup = null; // schematic people and vehicles (three-life.js), toggleable layer
    let lifeLayer = null; // __threeLife instance owning the instanced meshes of the current scene
    let sunLayer = null; // __threeSun attachment: the directional light as the sun, with shadows
    let lifeEnabled = true; // user toggle (default ON); real value loaded from storage on 3D init
    let lifeToggleEl = null;
    let groundLayer = null; // __threeGround instance: OSM-derived asphalt roadbed + pavement plane under the scene
    let groundEnabled = true; // user toggle (default ON); real value loaded from storage on 3D init
    let groundToggleEl = null;
    // Plots an applied urban rule left out, drawn as see-through volumes. Default OFF: it answers
    // "why is there nothing on this plot", it is not part of the plan being looked at.
    let showIneligibleParcels = false;

    // Checkbox listeners to sync 3D buildings with the Layers sheet
    let onShowExistingBuildingsChange = null;
    let onShowProposedBuildingsChange = null;

    const threeContainer = document.getElementById('three-container');
    const toggleBtn = document.getElementById('mode-3d-toggle');
    const toggle2dBtn = document.getElementById('mode-2d-toggle');
    const walkBtn = document.getElementById('mode-walk-toggle');
    // The walk launcher is map chrome: the shell's floating button (css/map-shell.css); map.css
    // only gives it its slot in the mode strip.
    if (walkBtn) walkBtn.classList.add('map-shell-button');

    // Sync the always-visible map / model / aerial buttons so exactly one reads
    // as "pressed" (aria-pressed): map when neither 3D mode is on, model for authored geometry,
    // aerial when the photoreal mesh is up. Called on every mode transition (here and
    // from photoreal-mode.js). Exposed globally so photoreal can reuse it.
    function updateModeButtonStates() {
        try {
            const rw = !!(window.PhotorealMode && typeof window.PhotorealMode.isActive === 'function' && window.PhotorealMode.isActive());
            // Loading spinners on the mode-strip buttons: photo while its tiles compose,
            // model (3D) while its scene renders. Photo entry passes through 3D init, so photo-loading
            // wins there — only the aerial button spins, never both.
            // The first click precedes this module's lazy load. Keep that requested mode
            // selected through module evaluation and the deferred scene initialization.
            const pendingMode = window.__pending3DMode;
            const photoLoading = pendingMode === 'photo'
                || !!(window.PhotorealMode && typeof window.PhotorealMode.isLoading === 'function' && window.PhotorealMode.isLoading());
            const modelLoading = (pendingMode === 'model' || isTransitioning3D || !!renderingStatusRelease) && !photoLoading && !rw;
            const desired = window.__mapModeState?.desired;
            const photoSelected = desired ? desired === 'photo' : rw || photoLoading;
            const modelSelected = desired ? desired === 'model' : !photoSelected && (isActive || modelLoading);
            const btn2d = document.getElementById('mode-2d-toggle');
            const btn3d = document.getElementById('mode-3d-toggle');
            const btnRw = document.getElementById('mode-realistic-toggle');
            for (const [button, active, loading] of [[btn2d, !modelSelected && !photoSelected, !!window.mapParcelsLoading?.()], [btn3d, modelSelected, modelLoading], [btnRw, photoSelected, photoLoading]]) {
                if (!button) continue;
                button.classList.toggle('mode-btn-loading', loading);
                button.setAttribute('aria-pressed', String(active));
            }
            // The AI render is a PHOTO of the scene: it only means anything over the photorealistic
            // mesh, so it appears only in the view that can supply that image.
            const btnAi = document.getElementById('mode-ai-toggle');
            if (btnAi) {
                btnAi.hidden = !isActive || !rw;
                btnAi.disabled = !rw;
                const label = rw
                    ? threeI18n('threeMode.toggle.ai', 'AI photorealistic render')
                    : threeI18n('threeMode.toggle.aiNeedsPhoto', 'Switch to photo view first — the AI render works from the photorealistic scene');
                btnAi.title = label;
                btnAi.setAttribute('aria-label', label);
            }
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
        // First, so the ghost renderers and facades below keep the night-window hook as their prior.
        nightWindows.configureMaterial(material, nightWindowState);
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

        material.userData[smoothTransparency.OPACITY_KEY] = 1;
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
            depthFunc: THREE.LessDepth,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
            ...parameters
        });
        return configureBuildingMaterial(material, opacity);
    }

    // Three.js Material.clone() does not copy custom compile hooks. Reapply the selected ghost
    // renderer whenever a material is cloned for a city face, parcel slice, or uploaded model.
    function cloneBuildingMaterial(material) {
        const cloned = material.clone();
        return configureBuildingMaterial(cloned, buildingOpacityOf(material));
    }

    function markOwnedMaterial(object, material) {
        if (typeof threeResources.markOwnedMaterials === 'function') {
            threeResources.markOwnedMaterials(object, material);
        }
    }

    function markOwnedGeometry(object, geometry) {
        threeResources.markOwned(object, 'geometries', geometry);
        return geometry;
    }

    function attachBuildingDepthPrepass(mesh) {
        if (BUILDING_GHOST_STYLE !== 'smooth' || !mesh) return null;
        const depthMesh = smoothTransparency.attachDepthPrepass(mesh, {
            lessDepth: THREE.LessDepth,
            createMesh: (geometry, material) => new THREE.Mesh(geometry, material)
        });
        if (depthMesh) markOwnedMaterial(depthMesh, depthMesh.material);
        return depthMesh;
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
        demolishedGhost: makeBuildingMaterial({ color: 0xa2645a, specular: 0x333333, shininess: 12 }, 0.3),
        // The permitted envelope behind an example build-out: a cool translucent hull, distinct
        // from `ghost` (which means built context) so the two never read as the same thing.
        // An example can touch its envelope. Give its actual roof/facades depth priority over
        // the envelope in BOTH the color and cloned depth passes, without moving either shape.
        massing: makeBuildingMaterial({ color: 0x7f95b3, specular: 0x223344, shininess: 8,
            polygonOffsetFactor: 2, polygonOffsetUnits: 2 }, 0.22),
        // A proposed building whose footprint cannot hold even the minimum stair core, shown when
        // suggested layouts are on: the warning IS the colour, so it stays saturated and opaque.
        flagged: makeBuildingMaterial({ color: 0xd9453a, specular: 0x331111, shininess: 10 }, 0.92)
    };

    for (const [role, material] of Object.entries(buildingMaterials)) material.userData.cbBuildingMaterialRole = role;

    function demolishedMaterialFor(buildingMaterial) {
        return buildingOpacityOf(buildingMaterial) < 1
            ? buildingMaterials.demolishedGhost
            : buildingMaterials.demolishedSolid;
    }

    const materials = {
        parcels: new THREE.MeshLambertMaterial({ color: 0xdddddd, emissive: 0x000000 }),
        // Ground lines sit just above their surfaces, but must stay behind solid buildings.
        parcelEdges: new THREE.LineBasicMaterial({ color: 0x999999, linewidth: 1, depthTest: true, depthWrite: false }),
        roads: new THREE.MeshLambertMaterial({ color: 0xb0b0b0, emissive: 0x000000 }),
        roadLines: new THREE.LineBasicMaterial({ color: 0x666666, linewidth: 1, depthTest: true, depthWrite: false }),
        sliceEdges: new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 })
    };

    // Building display: both families support solid / transparent / off. Built additionally offers
    // complementary Surviving and Removed views from the exact stored carve halves. Defaults make
    // the proposal pop against a translucent context.
    let builtDisplay = 'ghost';
    let plannedDisplay = 'solid';
    // How a planned urban rule is drawn — orthogonal to solid/transparent/off above:
    //   massing  — the permitted volume, which is what the proposal actually asserts
    //   buildout — one example of a legal build-out under it
    //   both     — the example inside a translucent envelope (the classic planning drawing)
    // A proposal that stores no rule (an imported shape, a single building) has no variation to
    // derive and draws identically in all three.
    let plannedRepresentation = 'both';
    let buildOutDisplaySalt = '';
    let buildingModeControlsEl = null;
    let decorTogglesEl = null; // container for per-layer scenery toggles, populated from /decor/layers

    // Parcel selection emphasizes the clicked ground while keeping the city and camera in place.
    // Proposal isolation remains a separate view with its own framing and visibility rules.
    let isolatedParcelId = null;
    let parcelEmphasisOriginals = new WeakMap();
    // Proposal isolation: showing a whole proposal (all its parcels + their buildings) at once,
    // reached via the [show] button in the parcel panel. null = not isolating a proposal.
    let isolatedProposalId = null;
    // Room around isolated ground when the camera frames it (1 = the diagonal touches the edges).
    const ISOLATION_FRAME_MARGIN = 1.5;
    let isolationResetEl = null;
    // Top-centre "Single parcel view [×]" banner: says the scene is filtered and how to leave.
    let isolationBannerEl = null;
    let parcelInfoPanelEl = null;
    // Floor areas of the currently-shown parcel or proposal ({ built, planned, proposed }, null where
    // not available), kept so the price sliders can recompute the comparison without re-running the
    // (price-independent) volume maths on every tick.
    let lastFloorAreas = null;
    // Parcel count behind the currently-shown panel (proposal panel only; null for single parcel),
    // so the price slider can recompute the average gain/loss per parcel live.
    let lastParcelCount = null;
    // Floor areas over the bound parcels only, when the panel's totals also cover open ground
    // (a partly bound site), so the per-parcel average does not credit open ground to owners.
    let lastParcelFloorAreas = null;

    // Assumptions for the value panel. GFA (floor area) is derived from the built, planned and
    // proposed volumes by dividing out a typical storey height; value and profit use two prices per
    // m² the user slides, a sale price and a construction cost, in the city's currency, starting from
    // city-money.js `currentFloorAreaPrices` (selected evidence, else explicit scenario assumptions).
    const FLOOR_HEIGHT_M = 3.5;        // "reasonably high" storey height for GFA estimation
    let panelPrices = null;            // { currency, sale, construction }; each perSqm moves with its slider

    // Keep slider positions only while the currency and economic source observations stay the same.
    function currentPanelPrices() {
        const fresh = window.CityMoney.currentFloorAreaPrices();
        if (!panelPrices || panelPrices.currency !== fresh.currency || panelPrices.sourceKey !== fresh.sourceKey) panelPrices = fresh;
        return panelPrices;
    }
    let parcelClickHandler = null;
    // The parcel under the last click (three-click-plan.js): its panel, its massing and its outline,
    // without dimming the city. Isolation (isolatedParcelId) is the deliberate second click.
    let viewedParcelId = null;
    let parcelPointerDownHandler = null;
    let inputHandler = null;      // pointermove/wheel on the canvas: noteInput
    let proposalSelectionUnsubscribe = null;
    // Pointer-down position, used to tell a short click apart from an orbit/tilt drag.
    let clickDownXY = null;

    // Scale factor to control how close the camera is vs top-down fit distance.
    // 1.0 means the 3D camera sits at the natural distance to fit the current
    // 2D map viewport — i.e. switching to 3D preserves the user's 2D altitude
    // and just adds tilt, instead of reframing to a different scale.
    const CAMERA_DISTANCE_SCALE = 1.0;

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
            { ghostOpacity: 0.38, markOwnedMaterials: threeResources.markOwnedMaterials }
        );
        applyParcelVisibilityForMode(derivedParcelVisibilityMode());
    }

    function setFacadeAppearance(enabled, style = facadeStyle, savePreference = true) {
        facadesEnabled = !!enabled;
        facadeStyle = buildingFacades.STYLES.some(preset => preset.id === style) ? style : 'mixed';
        buildingFacades.setState(facadeState, facadesEnabled, facadeStyle);
        facadeFloorLineMaterial.visible = !facadesEnabled;
        if (facadeCheckbox) facadeCheckbox.checked = facadesEnabled;
        if (facadeStyleSelect) {
            facadeStyleSelect.value = facadeStyle;
            facadeStyleSelect.disabled = !facadesEnabled;
        }
        if (facadeNote) facadeNote.hidden = !facadesEnabled;
        if (savePreference) {
            try {
                PersistentStorage.setItem(FACADE_PREF_KEY, facadesEnabled ? '1' : '0');
                PersistentStorage.setItem(FACADE_STYLE_KEY, facadeStyle);
            } catch (_) { }
        }
        // Shared uniforms only: toggling does not re-slice parcels, reload buildings or move the camera.
        // The view renders on demand, so the new uniforms only reach the screen with a requested frame.
        invalidateThreeView();
    }

    // Source massing is a representation of an obligatory proposal, never an applied building.
    // Reuse the scene's polygon extrusion and resource ownership without slicing the live cadastre.
    function hasVisiblePlanningRepresentations() {
        if (!window.PlanningViews) return false;
        const policy = window.PlanningViews.getPolicy();
        return window.PlanningViews.getItems().some(item => window.PlanningViews.getAppearance(item) !== 'off')
            || window.PlanningViews.getSelected()?.role === 'existing' && policy.existing !== 'off';
    }
    function rebuildPlanningSources3D() {
        if (!isActive || !planningSourcesGroup || !window.PlanningViews) return;
        clearGroupChildren(planningSourcesGroup);
        const view = window.PlanningViews.getPolicy();
        const inspected = window.PlanningViews.getSelected();
        const builtSelection = inspected?.role === 'existing' && view.existing !== 'off' && !realisticLayerActive;
        planningSourcesGroup.visible = hasVisiblePlanningRepresentations();
        if (!planningSourcesGroup.visible) { invalidateThreeView(); return; }
        const selectedId = window.PlanningViews.getState()?.selectedId;
        for (const item of window.PlanningViews.getItems()) {
            const appearance = window.PlanningViews.getAppearance(item);
            if (appearance === 'off') continue;
            const color = window.PlanningViews.color(item.role);
            for (const area of item.areas || []) {
                const material = new THREE.MeshBasicMaterial({ color, transparent: true,
                    opacity: appearance === 'solid' ? 0.55 : 0.15, depthWrite: false, side: THREE.DoubleSide });
                const meshes = polygonFeatureToMeshes({ type: 'Feature', geometry: area.geometry }, material, 0.01, 0);
                if (!meshes.length) material.dispose();
                for (const mesh of meshes) {
                    markOwnedMaterial(mesh, material); mesh.userData.planningRepresentationId = item.id;
                    mesh.renderOrder = 2; planningSourcesGroup.add(mesh);
                }
                if (item.id === selectedId) {
                    const line = new THREE.LineBasicMaterial({ color, depthWrite: false });
                    const borders = polygonFeatureToBorderLines({ geometry: area.geometry }, line, 0.025);
                    if (!borders.length) line.dispose();
                    for (const border of borders) { markOwnedMaterial(border, line); planningSourcesGroup.add(border); }
                }
            }
            // The outer bound behind a shown configuration is a faint hull; alone, it is the body.
            const { bound, body } = window.PlanningViews.permittedFeatures(item);
            for (const feature of [...bound, ...body]) {
                const selected = item.id === selectedId;
                const hull = feature.properties.geometryRole === 'bound' && body.length > 0;
                // A tier only an incentive's condition reaches is fainter than the granted bound.
                const conditional = Boolean(feature.properties.condition);
                const material = new THREE.MeshPhongMaterial({ color, emissive: selected ? color : 0, emissiveIntensity: selected ? 0.15 : 0,
                    transparent: hull || conditional || appearance === 'ghost', opacity: conditional ? 0.05 : hull ? 0.1 : appearance === 'solid' ? 1 : 0.25,
                    depthWrite: !hull && !conditional && appearance === 'solid', side: THREE.FrontSide, polygonOffset: true,
                    polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
                const meshes = polygonFeatureToMeshes(feature, material, feature.properties.baseM, feature.properties.height);
                if (!meshes.length) { material.dispose(); continue; }
                for (const mesh of meshes) {
                    markOwnedMaterial(mesh, material);
                    mesh.userData.planningRepresentationId = item.id;
                    mesh.renderOrder = 3;
                    planningSourcesGroup.add(mesh);
                    const geometry = new THREE.EdgesGeometry(mesh.geometry);
                    const edgeMaterial = new THREE.LineBasicMaterial({ color, transparent: true, opacity: conditional ? 0.2 : hull ? 0.35 : selected ? 1 : 0.6, depthWrite: false });
                    const edges = new THREE.LineSegments(geometry, edgeMaterial);
                    markOwnedGeometry(edges, geometry); markOwnedMaterial(edges, edgeMaterial);
                    edges.renderOrder = 4;
                    planningSourcesGroup.add(edges);
                }
            }
        }
        if (builtSelection) {
            const tint = window.PlanningViews.color('existing');
            for (const feature of window.PlanningEnvelopes.volumeFeatures(inspected)) {
                const material = new THREE.MeshBasicMaterial();
                const meshes = polygonFeatureToMeshes(feature, material, feature.properties.baseM, feature.properties.height);
                for (const mesh of meshes) {
                    const geometry = new THREE.EdgesGeometry(mesh.geometry);
                    const line = new THREE.LineBasicMaterial({ color: tint, depthTest: false, transparent: true, opacity: 1 });
                    const edges = new THREE.LineSegments(geometry, line);
                    markOwnedGeometry(edges, geometry); markOwnedMaterial(edges, line);
                    edges.renderOrder = 5; planningSourcesGroup.add(edges); mesh.geometry.dispose();
                }
                material.dispose();
            }
        }
        sunLayer?.syncObjects(planningSourcesGroup);
        invalidateThreeView();
    }

    function syncPlanningView3D() {
        const policy = window.PlanningViews?.getPolicy();
        if (!policy) return;
        const state = window.PlanningViews.getState();
        const geometryChanged = plannedRepresentation !== state.proposedForm || buildOutDisplaySalt !== state.proposedVariation;
        builtDisplay = policy.existing;
        plannedDisplay = policy.proposed;
        plannedRepresentation = state.proposedForm;
        buildOutDisplaySalt = state.proposedVariation;
        if (isActive) {
            const retained = applyRetainedBuildingDisplay();
            if (!retained) rebuild3DBuildingsOnly();
            else if (geometryChanged) rebuild3DBuildingsOnly({ family: 'planned' });
            applyModeVisibility();
            rebuildPlanningSources3D();
        } else buildingViewDirty = true;
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

    let buildingRadiusPreview = null;
    let stopBuildingRadiusPreview = null;
    function showBuildingRadiusPreview(radiusMeters, visible) {
        if (!visible || !isActive || realisticLayerActive) {
            if (buildingRadiusPreview) buildingRadiusPreview.visible = false;
            invalidateThreeView();
            return;
        }
        if (!scene || !origin3857 || !sceneLoadGeometry) return;
        if (!buildingRadiusPreview) {
            buildingRadiusPreview = new THREE.Group();
            buildingRadiusPreview.name = 'building-load-radius-preview';
            scene.add(buildingRadiusPreview);
        }
        if (buildingRadiusPreview.userData.radiusMeters !== radiusMeters) {
            const preview = snapshotNavigation.buildLoadRadiusPreview(sceneLoadGeometry, radiusMeters, turf);
            if (!preview) return;
            threeResources.disposeSharedSubtree(buildingRadiusPreview);
            buildingRadiusPreview.clear();
            const outer = preview.ring.map(coordsToXY);
            const inner = preview.innerRing.map(coordsToXY);
            const band = [];
            for (let i = 0; i < outer.length - 1; i++) {
                for (const point of [outer[i], inner[i], outer[i + 1], inner[i], inner[i + 1], outer[i + 1]]) {
                    band.push(point[0], point[1], 0.6);
                }
            }
            const borderGeometry = new THREE.BufferGeometry();
            borderGeometry.setAttribute('position', new THREE.Float32BufferAttribute(band, 3));
            const fillGeometry = new THREE.ShapeGeometry(new THREE.Shape(outer.map(p => new THREE.Vector2(p[0], p[1]))));
            for (const [geometry, opacity, order] of [[fillGeometry, 0.07, 1000], [borderGeometry, 0.95, 1001]]) {
                const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
                    color: 0x2563eb, opacity, transparent: true, depthTest: false, depthWrite: false,
                    side: THREE.DoubleSide
                }));
                mesh.renderOrder = order;
                // This temporary measurement overlay must never intercept parcel selection.
                mesh.raycast = () => {};
                buildingRadiusPreview.add(mesh);
            }
            buildingRadiusPreview.userData = { radiusMeters, center: preview.center };
        }
        buildingRadiusPreview.visible = true;
        invalidateThreeView();
    }

    function getParcelFeatureById(parcelId) {
        return window.LiveParcelFabric?.get?.(String(parcelId))
            || window.CadastralParcelRepository?.get?.(String(parcelId)) || null;
    }

    function applyParcelEmphasis() {
        const emphasis = window.ThreeParcelEmphasis;
        if (!emphasis || !scene) return;
        parcelEmphasisOriginals = emphasis.apply(scene, isolatedParcelId, parcelEmphasisOriginals,
            { dimOthers: isolatedParcelId !== null });
    }

    function restoreParcelEmphasis() {
        const emphasis = window.ThreeParcelEmphasis;
        if (!emphasis || !scene) return;
        parcelEmphasisOriginals = emphasis.apply(scene, null, parcelEmphasisOriginals);
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
        return computeGroundMetrics(getParcelFeatureById(parcelId));
    }

    // The same volume maths over any ground polygon: a parcel, or a proposal's site.
    function computeGroundMetrics(groundFeature) {
        if (!groundFeature) return null;
        return window.ProposalGain.computeParcelMetrics(
            groundFeature,
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
            try { const translated = api.t(key, params || {}); if (translated !== key) return translated; } catch (_) { /* fall through */ }
        }
        return fallback;
    }

    function formatInt(n) {
        return CbFormat.formatNumber(Math.round(Number(n) || 0), { maxFractionDigits: 0 });
    }

    // Values here are in the panel prices' currency: amount then code, "+1,234 GBP".
    function formatPanelMoney(n) {
        return CbFormat.formatMoney(Math.round(Number(n) || 0), currentPanelPrices().currency);
    }

    // The planned floor area over `parcelIds`: the permitted massing of each parcel (the Permitted
    // layer's items, PlanningScene.parcelItemOf), its volume over the same storey height as Built and
    // Proposed. Null when any parcel has no permitted massing loaded: a part sum would read as the plan.
    function plannedMetrics(parcelIds) {
        const items = window.PlanningViews?.getItems?.() || [];
        const scene = window.PlanningScene;
        if (!scene || !items.length) return null;
        let volume = 0, conditionalVolume = 0, counted = 0;
        const conditions = [];
        for (const id of parcelIds) {
            const item = scene.parcelItemOf(items, id);
            if (!item || !Array.isArray(item.volumes) || !item.volumes.length) return null;
            // What the rules grant is the plan; an incentive's conditional storeys are reported beside it.
            const permitted = window.PlanningEnvelopes.permittedVolume(item, turf);
            volume += permitted.grantedM3;
            conditionalVolume += permitted.conditionalM3;
            for (const condition of permitted.conditions) if (!conditions.includes(condition)) conditions.push(condition);
            counted += 1;
        }
        if (!counted) return null;
        const conditional = conditionalVolume > 0 ? { volume: conditionalVolume, floorArea: conditionalVolume / FLOOR_HEIGHT_M, condition: conditions.join('; ') } : null;
        return { volume, floorArea: volume / FLOOR_HEIGHT_M, conditional };
    }

    // --- Proposal lookup helpers (for the click stack's Design section) ---
    // The proposals on a parcel, applied ones first (those are the ones the scene draws).
    function getProposalsForParcel(parcelId) {
        try {
            const store = (typeof window !== 'undefined') ? window.proposalStorage : null;
            if (!store || typeof store.getProposalsForParcel !== 'function') return [];
            const list = store.getProposalsForParcel(parcelId) || [];
            return [...list.filter(p => isApplied(p)), ...list.filter(p => !isApplied(p))];
        } catch (_) { return []; }
    }

    function proposalDisplayTitle(p) {
        if (!p) return '';
        return p.title || p.name || p.proposalName || ('Design ' + (p.proposalId || p.id || ''));
    }

    function proposalIdOf(p) {
        return p ? (p.proposalId || p.id || null) : null;
    }

    // Union of the durable cadastral scope and this fabric revision's materialized output.
    function getProposalParcelIdSet(proposal) {
        const ids = new Set();
        if (!proposal) return ids;
        const add = (arr) => { if (Array.isArray(arr)) arr.forEach(id => { if (id != null) ids.add(String(id)); }); };
        add(proposal.cadastreParcelIds);
        const fabric = window.LiveParcelFabric;
        if (proposal.proposalId && fabric?.producedBy && fabric?.featureId) {
            add(fabric.producedBy(proposal.proposalId).map(feature => fabric.featureId(feature)));
        }
        return ids;
    }

    // The figures of the Design and Parcel sections of the click stack (three-click-stack.js): one
    // element, filled for whichever of the two is expanded and moved into its body.
    function ensureParcelInfoPanel() {
        if (!parcelInfoPanelEl) {
            parcelInfoPanelEl = document.createElement('div');
            parcelInfoPanelEl.className = 'three-mode-parcel-panel';
        }
        return parcelInfoPanelEl;
    }

    // The two money rows' cells and the price labels from the current slider prices and the stored
    // floor areas (gain.js computeValueComparison). Cheap — runs on every slider tick.
    function renderValueComparison(panel) {
        const prices = currentPanelPrices();
        const comparison = window.ProposalGain.computeValueComparison({
            floorAreas: lastFloorAreas || {},
            salePerM2: prices.sale.perSqm,
            constructionPerM2: prices.construction.perSqm,
            currency: prices.currency,
            parcelCount: lastParcelCount,
            parcelFloorAreas: lastParcelFloorAreas
        });
        const money = value => typeof value === 'number' && Number.isFinite(value)
            ? CbFormat.formatMoney(Math.round(value), prices.currency) : '—';
        const signedClass = value => (value > 0 ? 'gain-positive' : (value < 0 ? 'gain-negative' : ''));
        ['built', 'planned', 'proposed'].forEach(column => {
            const figures = comparison.columns[column];
            ['value', 'constructionCost', 'profit'].forEach(row => {
                const cell = panel.querySelector(`[data-cell="${row}:${column}"]`);
                if (!cell) return;
                const amount = figures[row];
                const shown = typeof amount === 'number';
                cell.textContent = shown ? `${row === 'profit' && amount > 0 ? '+' : ''}${CbFormat.formatCompact(Math.round(amount))}` : '—';
                cell.title = shown ? money(amount) : '';
                cell.className = row === 'profit' && shown ? signedClass(amount) : '';
                if (!figures.available) cell.classList.add('is-unavailable');
            });
        });
        const saleLabel = panel.querySelector('[data-role="sale-label"]');
        if (saleLabel) saleLabel.textContent = threeI18n('threeMode.parcelPanel.salePrice', 'Sale price {{price}}/m²', { price: money(prices.sale.perSqm) });
        const costLabel = panel.querySelector('[data-role="construction-label"]');
        if (costLabel) costLabel.textContent = threeI18n('threeMode.parcelPanel.constructionPrice', 'Construction cost {{price}}/m²', { price: money(prices.construction.perSqm) });

        // Proposal panel only: the proposed profit per bound parcel.
        const avgEl = panel.querySelector('[data-role="avg-gain"]');
        if (avgEl) {
            const avg = comparison.avgProfitPerParcel;
            avgEl.className = 'parcel-panel-avg' + (avg !== null ? ' ' + signedClass(avg) : '');
            avgEl.textContent = avg !== null
                ? `${threeI18n('threeMode.proposalPanel.avgPerParcel', 'Avg / parcel')}: ${avg > 0 ? '+' : ''}${money(avg)}`
                : '';
        }
    }

    // Shared by the parcel and proposal panels: wire the two price sliders and render the comparison
    // from the current prices and lastFloorAreas.
    function wireSliderAndGain(panel) {
        [['sale-slider', 'sale'], ['construction-slider', 'construction']].forEach(([role, key]) => {
            const slider = panel.querySelector(`[data-role="${role}"]`);
            if (!slider) return;
            slider.title = window.EconomicSourceSettings?.describe(currentPanelPrices().sources[key], window) || '';
            slider.addEventListener('input', () => {
                const v = Number(slider.value);
                if (Number.isFinite(v)) currentPanelPrices()[key].perSqm = v;
                slider.title = threeI18n('economicSources.assumption', 'Scenario assumption');
                renderValueComparison(panel);
            });
        });
        renderValueComparison(panel);
    }

    // The Built / Planned / Proposed comparison shared by both panels: volume and floor area, then
    // value, construction cost and profit (filled by renderValueComparison), and the two sliders.
    // `m` holds { built, planned, proposed } each { volume, floorArea } or null; a null column is
    // not available and is greyed out.
    function metricsTableHtml(L, m) {
        const prices = currentPanelPrices();
        const columns = ['built', 'planned', 'proposed'];
        const off = column => (m[column] ? '' : ' class="is-unavailable"');
        const cells = (render, column) => (m[column] ? render(m[column]) : '—');
        const row = (label, render) => `<tr><th scope="row">${label}</th>${columns.map(c => `<td${off(c)}>${cells(render, c)}</td>`).join('')}</tr>`;
        const moneyRow = (label, key, hint = '') => `<tr><th scope="row"${hint ? ` title="${escapeHtml(hint)}"` : ''}>${label}</th>${columns.map(c => `<td data-cell="${key}:${c}"${off(c)}>—</td>`).join('')}</tr>`;
        const slider = (role, labelRole, price) => {
            const id = `parcel-panel-${role}`;
            return `
            <label for="${id}" class="parcel-panel-slider-label" data-role="${labelRole}"></label>
            <input id="${id}" type="range" class="parcel-panel-price-slider" data-role="${role}"
                min="${price.min}" max="${price.max}" step="${price.step}" value="${price.perSqm ?? price.min}"${price.perSqm === null ? ' disabled' : ''}>`;
        };
        return `
            <table class="parcel-panel-table">
                <thead><tr><th scope="col"></th>${columns.map(c => `<th scope="col"${off(c)}>${L[c]}</th>`).join('')}</tr></thead>
                <tbody>
                    ${row(L.volume, v => `${formatInt(v.volume)} m³`)}
                    ${row(L.floorArea, v => CbFormat.formatArea(Number(v.floorArea) || 0))}
                    ${moneyRow(L.value, 'value')}
                    ${moneyRow(L.constructionCost, 'constructionCost')}
                    ${moneyRow(L.profit, 'profit', L.profitNote)}
                </tbody>
            </table>
            ${m.planned?.conditional ? `<p class="parcel-panel-note">${escapeHtml(threeI18n('threeMode.parcelPanel.plannedConditional',
                'Planned is what the rules grant; {{floorArea}} more needs: {{condition}}',
                { floorArea: CbFormat.formatArea(m.planned.conditional.floorArea), condition: m.planned.conditional.condition }))}</p>` : ''}
            <p class="parcel-panel-note">${L.floorNote} · ${escapeHtml(threeI18n('threeMode.parcelPanel.amountsIn', 'amounts in {{currency}}', { currency: prices.currency }))}</p>
            ${slider('sale-slider', 'sale-label', prices.sale)}
            ${slider('construction-slider', 'construction-label', prices.construction)}`;
    }

    function panelLabels() {
        return {
            built: threeI18n('threeMode.parcelPanel.built', 'Built'),
            planned: threeI18n('threeMode.parcelPanel.planned', 'Planned'),
            proposed: threeI18n('threeMode.parcelPanel.proposed', 'Proposed'),
            volume: threeI18n('threeMode.parcelPanel.volume', 'Volume'),
            value: threeI18n('threeMode.parcelPanel.value', 'Value'),
            constructionCost: threeI18n('threeMode.parcelPanel.constructionCost', 'Construction cost'),
            profit: threeI18n('threeMode.parcelPanel.profit', 'Profit'),
            profitNote: threeI18n('threeMode.parcelPanel.profitNote', 'Profit = value − construction cost − built value'),
            floorArea: threeI18n('threeMode.parcelPanel.floorArea', 'Floor area'),
            floorNote: threeI18n('threeMode.parcelPanel.floorNote', '@ {{h}} m/floor', { h: FLOOR_HEIGHT_M }),
            parcelsLabel: threeI18n('threeMode.proposalPanel.parcelsLabel', 'Parcels')
        };
    }

    // The Parcel section's figures for one parcel; false when the parcel cannot be measured.
    function updateParcelInfoPanel(parcelId) {
        const panel = ensureParcelInfoPanel();
        const m = computeParcelMetrics(parcelId);
        if (!m) return false;
        const planned = plannedMetrics([parcelId]);
        const hasProposed = m.proposedFloorArea > 0;
        lastFloorAreas = { built: m.builtFloorArea, planned: planned ? planned.floorArea : null, proposed: hasProposed ? m.proposedFloorArea : null };
        lastParcelCount = null; // single parcel — no per-parcel average
        lastParcelFloorAreas = null;

        const L = panelLabels();
        const suggestedText = suggestedParcelPanelText(parcelId);
        const suggestedRow = suggestedText ? `
            <p class="parcel-panel-subnote parcel-panel-suggested">${escapeHtml(threeI18n('threeMode.parcelPanel.suggestedLayout', 'Suggested layout'))}: ${escapeHtml(suggestedText)}</p>` : '';
        // The full cadastral id: the stack's row shows the short number.
        panel.innerHTML = `
            <p class="parcel-panel-subnote parcel-id-text">${escapeHtml(String(parcelId))}</p>
            ${suggestedRow}
            ${metricsTableHtml(L, {
                built: { volume: m.builtVolume, floorArea: m.builtFloorArea },
                planned,
                proposed: hasProposed ? { volume: m.proposedVolume, floorArea: m.proposedFloorArea } : null
            })}
        `;

        wireSliderAndGain(panel);
        return true;
    }

    // A proposal's site as a feature (site-binding.js: authored site, else its own footprint).
    function proposalSiteFeature(proposal) {
        try {
            const site = window.__siteBinding?.siteOf?.(proposal, { turf }) || null;
            return site ? { type: 'Feature', properties: {}, geometry: site } : null;
        } catch (_) { return null; }
    }

    // The Design section's figures for a whole proposal: totals across all its parcels, total
    // gain/loss. The ground rule (which figures are site metrics, which need a binding) is in gain.js
    // summarizeProposalGround: on open ground the totals are the site's and there is no parcel count.
    // False when there is nothing to measure.
    function updateProposalInfoPanel(proposal, idSet) {
        const panel = ensureParcelInfoPanel();
        const siteStats = window.__siteStats || null;
        const ground = siteStats ? siteStats.groundOf(proposal) : null;
        const parcelMetrics = [];
        idSet.forEach(id => {
            // A piece minted on open ground is not a parcel; its ground is measured with the site.
            if (siteStats && siteStats.isGroundPiece(getParcelFeatureById(id))) return;
            const m = computeParcelMetrics(id);
            if (m) parcelMetrics.push(m);
        });
        const siteMetrics = window.ProposalGain.needsSiteMetrics(ground)
            ? computeGroundMetrics(proposalSiteFeature(proposal))
            : null;
        const summary = window.ProposalGain.summarizeProposalGround({ parcelMetrics, siteMetrics, ground });
        if (!summary) return false;
        // Planned over the proposal's parcels; on open ground (no parcels) there is no plan to compare.
        const planned = summary.parcelCount ? plannedMetrics([...idSet]) : null;
        const hasProposed = summary.proposedFloorArea > 0;
        lastFloorAreas = { built: summary.builtFloorArea, planned: planned ? planned.floorArea : null, proposed: hasProposed ? summary.proposedFloorArea : null };
        lastParcelCount = summary.parcelCount;
        lastParcelFloorAreas = summary.parcelFloorAreas;

        const L = panelLabels();
        const lines = [];
        if (summary.siteM2 !== null) {
            lines.push(threeI18n('groundStats.siteAreaValue', 'Site: {{area}} m²', { area: formatInt(summary.siteM2) })
                .replace('{{area}}', formatInt(summary.siteM2)));
        }
        lines.push(summary.parcelCount === null
            ? threeI18n('groundStats.noParcels', 'No parcels here')
            : `${L.parcelsLabel}: ${summary.parcelCount}`);
        if (summary.parcelCount !== null && summary.openGroundM2 !== null && summary.openGroundM2 > 0) {
            lines.push(threeI18n('groundStats.openGroundValue', 'Open ground: {{area}} m²', { area: formatInt(summary.openGroundM2) })
                .replace('{{area}}', formatInt(summary.openGroundM2)));
        }
        const suggestedLine = suggestedProposalPanelText(proposal);
        if (suggestedLine) lines.push(suggestedLine);
        panel.innerHTML = `
            ${lines.map(line => `<p class="parcel-panel-subnote">${escapeHtml(line)}</p>`).join('')}
            ${metricsTableHtml(L, {
                built: { volume: summary.builtVolume, floorArea: summary.builtFloorArea },
                planned,
                proposed: hasProposed ? { volume: summary.proposedVolume, floorArea: summary.proposedFloorArea } : null
            })}
            <div class="parcel-panel-avg" data-role="avg-gain"></div>
        `;
        wireSliderAndGain(panel);
        return true;
    }

    // Show only the given set of parcels (and the buildings on them). Used for whole-proposal
    // isolation. parcelFeatures are the polygons for testing existing
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
        [existingBuildingsGroup, proposedBuildingsGroup, ineligibleBuildingsGroup, floorPlanGroup].filter(Boolean).forEach(group => group.children.forEach(c => {
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
        }));
        updateXrayControls();
        // Planned decorations aren't parcel-specific; hide them while isolated.
        [plannedFlatGroup, parkGroup, squareGroup, lakeGroup, stationGroup, existingTransitAlignmentGroup].forEach(g => { if (g) g.visible = false; });
    }

    // Hide everything except the given parcel and the building footprint(s) on it.
    // The photoreal layer carves the mesh for every applied proposal; when isolation hides
    // some proposals' surfaces, their carve holes would gape open — so it listens for this.
    function notifyIsolationChanged() {
        try {
            window.dispatchEvent(new CustomEvent('threeModeIsolationChanged', {
                // Parcel selection now emphasizes in place; only proposal isolation removes
                // proposal surfaces from the scene.
                detail: { proposalId: isolatedProposalId, parcelId: null }
            }));
        } catch (_) { }
    }

    function isolateParcel(parcelId) {
        if (!parcelId) return;
        // If the current view is a whole-proposal isolation, restore it before changing view type.
        if (isolatedProposalId !== null) clearIsolation();
        isolatedParcelId = parcelId;
        viewedParcelId = parcelId;
        isolatedProposalId = null;
        updateIsolationButton();
        applyParcelEmphasis();
        // A parcel selection does not isolate photoreal proposal cuts either: all city surfaces
        // remain present while the selected parcel receives the bright outline/fill.
        notifyIsolationChanged();
    }

    // Isolation hides the whole city around the chosen ground, so leaving the camera where it was
    // left a lone speck mid-screen — on a phone, a few pixels above the info panel. Keep the
    // current heading and tilt, and move in (or out) until the isolated ground fills the view.
    function frameIsolatedFeatures(features) {
        try {
            if (!features.length || typeof turf === 'undefined' || !camera) return;
            const view = getGeoCameraView();
            if (!view) return;
            const bbox = turf.bbox(turf.featureCollection(features));
            if (!bbox.every(Number.isFinite)) return;
            const diagonalM = turf.distance([bbox[0], bbox[1]], [bbox[2], bbox[3]], { units: 'meters' });
            const vFov = THREE.MathUtils.degToRad(camera.fov);
            const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
            const fov = Math.min(vFov, hFov);
            const range = Math.max(40, ((diagonalM / 2) / Math.tan(fov / 2)) * ISOLATION_FRAME_MARGIN);
            applyGeoCameraView({
                ...view,
                targetLng: (bbox[0] + bbox[2]) / 2,
                targetLat: (bbox[1] + bbox[3]) / 2,
                range
            });
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [three-mode] could not frame the isolated view`, error);
        }
    }

    // Hide everything except the parcels (and their buildings) belonging to a whole proposal.
    function isolateProposal(proposalId) {
        const store = (typeof window !== 'undefined') ? window.proposalStorage : null;
        const proposal = (store && typeof store.getProposal === 'function') ? store.getProposal(proposalId) : null;
        if (!proposal) return;
        const idSet = getProposalParcelIdSet(proposal);
        // A proposal on open ground has no parcels to isolate; it still has a site to frame and
        // figures to show, so the scene stays as it is and only the panel and camera follow it.
        const siteFeature = idSet.size ? null : proposalSiteFeature(proposal);
        if (!idSet.size && !siteFeature) return;
        if (isolatedParcelId !== null) clearIsolation();
        isolatedProposalId = String(proposalId);
        isolatedParcelId = null;
        updateIsolationButton();
        if (siteFeature) {
            frameIsolatedFeatures([siteFeature]);
            notifyIsolationChanged();
            return;
        }
        const feats = [];
        idSet.forEach(id => { const f = getParcelFeatureById(id); if (f) feats.push(f); });
        applyIsolationVisibility(idSet, feats);
        frameIsolatedFeatures(feats);
        notifyIsolationChanged();
    }

    // A proposal opened from a list, a link, a search or the activity feed while the scene is up:
    // frame its ground where it stands when the scene has it, else the scene has to be rebuilt
    // around it (three-focus-plan.js decides). Returns the plan's action.
    function frameProposalsInScene(ids) {
        const plan = window.__threeFocusPlan;
        if (!plan || typeof plan.planProposalFocus !== 'function' || !isActive) return 'none';
        const targets = ids.map(id => {
            const proposal = resolveProposalForFocus(id);
            if (!proposal) return null;
            const parcelIds = Array.from(getProposalParcelIdSet(proposal));
            const features = parcelIds.map(getParcelFeatureById).filter(Boolean);
            return { id: String(id), parcelIds, features, siteFeature: parcelIds.length ? null : proposalSiteFeature(proposal) };
        }).filter(Boolean);
        let origin = null;
        try { const ll = xyToLatLng(0, 0); origin = { lat: ll.lat, lng: ll.lng }; } catch (_) { }
        const decision = plan.planProposalFocus({ targets, originLatLng: origin, radiusM: buildingLoadRadiusM });
        console.log(`[${new Date().toISOString()}] [3D] focus on ${ids.join(',')}: ${decision.action} (${decision.reason})`);
        if (decision.action === 'frame') frameIsolatedFeatures(decision.features);
        return decision.action;
    }

    function resolveProposalForFocus(id) {
        const store = window.proposalStorage;
        return (typeof window.getProposalByIdOrHash === 'function' ? window.getProposalByIdOrHash(id) : null)
            || ((store && typeof store.getProposal === 'function') ? store.getProposal(id) : null);
    }

    // Where a proposal stands, for moving the map to it: its loaded parcels, else its own
    // geometry (buildings, corridor, structure), else its site or stored footprint.
    function proposalGroundFeatures(proposal) {
        const feats = [];
        getProposalParcelIdSet(proposal).forEach(id => { const f = getParcelFeatureById(id); if (f) feats.push(f); });
        if (feats.length) return feats;
        try {
            const sets = (typeof collectProposalFeatureSets === 'function') ? collectProposalFeatureSets(proposal) : null;
            (sets?.primaryFeatures || []).forEach(f => { if (f?.geometry) feats.push(f); });
        } catch (_) { /* a record without derivable geometry */ }
        if (feats.length) return feats;
        const site = proposalSiteFeature(proposal);
        if (site) feats.push(site);
        else if (proposal.geometry?.type && proposal.geometry.coordinates) feats.push({ type: 'Feature', properties: {}, geometry: proposal.geometry });
        return feats;
    }

    // Relocating the scene: the 2D map goes to the proposals first and loads their parcels (the
    // scene's ground comes from the loaded fabric), then enter3D anchors the new scene on them.
    async function settleGroundForProposals(ids) {
        const proposals = ids.map(resolveProposalForFocus).filter(Boolean);
        const parcelIds = [];
        proposals.forEach(proposal => parcelIds.push(...getProposalParcelIdSet(proposal)));
        try {
            if (parcelIds.length && window.CadastralParcelRepository?.ensureIds) await window.CadastralParcelRepository.ensureIds(parcelIds);
        } catch (error) { console.warn(`[${new Date().toISOString()}] [3D] ground of ${ids.join(',')} did not load`, error); }
        if (typeof map === 'undefined' || !map) return;
        const features = [];
        proposals.forEach(proposal => features.push(...proposalGroundFeatures(proposal)));
        const center = window.__threeFocusPlan?.featuresCenter?.(features);
        if (center) {
            try {
                window.suppressCameraMoves = true;
                map.setView([center.lat, center.lng], Math.max(map.getZoom() || 0, 17), { animate: false });
            } catch (error) { console.warn(`[${new Date().toISOString()}] [3D] could not move the map to ${ids[0]}`, error); }
            finally { window.suppressCameraMoves = false; }
        }
        try {
            if (typeof window.fetchParcelData === 'function') await window.fetchParcelData(map.getBounds());
        } catch (error) { console.warn(`[${new Date().toISOString()}] [3D] parcels around ${ids.join(',')} did not load`, error); }
    }

    // Entry for the 2D selection path and the share routes (window.focusThreeModeOnProposals):
    // frames in place, or asks the mode controller to rebuild the scene around the proposals,
    // which lands in enter3D with the ids as its focus. One rebuild per set of ids at a time.
    let relocatingFocusKey = null;
    function focusThreeModeOnProposals(ids) {
        const list = (Array.isArray(ids) ? ids : [ids]).filter(id => id != null).map(String);
        if (!isActive || !list.length) return false;
        if (frameProposalsInScene(list) !== 'relocate') {
            if (!stackDriving) showThreeModeDesign(list[0]);
            return true;
        }
        const key = list.join(',');
        if (relocatingFocusKey === key) return true;
        if (typeof window.requestMapMode !== 'function') return false;
        relocatingFocusKey = key;
        Promise.resolve(window.requestMapMode(realisticLayerActive ? 'photo' : 'model', { focusProposalIds: list }))
            .then(entered => {
                // The rebuild drops the selection with the old scene; the proposals stay chosen.
                if (entered && isActive && typeof window.selectAndHighlightProposal === 'function') {
                    window.selectAndHighlightProposal(list[0], null, false, false, true);
                }
            })
            .catch(error => console.warn(`[${new Date().toISOString()}] [3D] could not rebuild the scene around ${key}`, error))
            .finally(() => { if (relocatingFocusKey === key) relocatingFocusKey = null; });
        return true;
    }

    // The parcel under the click owns its figures and outline. Display settings remain global.
    // Null ends the parcel view.
    function viewParcel(parcelId) {
        viewedParcelId = parcelId ? String(parcelId) : null;
        applyParcelEmphasis();
    }

    function clearIsolation() {
        if (isolatedParcelId === null && isolatedProposalId === null) { if (viewedParcelId !== null) viewParcel(null); return; }
        viewedParcelId = null;
        const wasProposalIsolated = isolatedProposalId !== null;
        isolatedParcelId = null;
        isolatedProposalId = null;
        updateIsolationButton();
        restoreParcelEmphasis();
        if (!wasProposalIsolated) {
            notifyIsolationChanged();
            return;
        }
        // Restore every flatGroup child (roads + all parcels) before re-applying the mode,
        // which may then re-hide applied-descendant parcels in Built mode.
        if (flatGroup) flatGroup.children.forEach(c => { c.visible = true; });
        // Rebuild buildings so their per-object visibility resets cleanly to the mode default.
        rebuild3DBuildingsOnly();
        applyModeVisibility();
        notifyIsolationChanged();
    }

    // ── The click stack (three-click-stack.js) ──
    // Ends what a click opened: the stack and the isolation or parcel view under it. clearIsolation
    // alone is the scene half, which isolating another proposal or parcel also runs on its way.
    function endSelectionView() {
        window.ThreeClickStack?.close({ silent: true });
        clearIsolation();
    }

    // A user dismissing the scene selection also clears the shared design selection. An outside
    // inspector change only ends the old view, so it can retain the selection it just made.
    function deselectScene() {
        endSelectionView();
        window.SelectionAddress?.write(null);
        window.ProposalSelection?.clear?.();
    }

    // Inspector selection follows stack sections; those changes must not end the scene selection.
    let stackDriving = false;
    let stackInspector = null;   // { el, parent, next, selectedId } while the stack hosts the inspector
    function withStackDriving(run) {
        const previous = stackDriving;
        stackDriving = true;
        try { return run(); } finally { stackDriving = previous; }
    }

    function hostInspector(body) {
        const el = document.getElementById('planning-inspector');
        if (!el || !body) return;
        if (stackInspector?.el !== el) stackInspector = { el, parent: el.parentNode, next: el.nextSibling };
        stackInspector.selectedId = window.PlanningViews?.getSelected()?.id || null;
        el.classList.add('is-hosted');
        body.appendChild(el);
    }

    let stackFocusGroup = null;
    let stackFocusPulseStart = 0;
    const STACK_PULSE_MS = 1400;
    const STACK_PULSES = 3;   // the outline pulses this many times, then rests bright
    function pulseStackFocus(now) {
        if (!stackFocusPulseStart) stackFocusPulseStart = now;
        const done = now - stackFocusPulseStart >= STACK_PULSE_MS * STACK_PULSES;
        const strength = done ? 1 : (1 + Math.cos((now - stackFocusPulseStart) * Math.PI * 2 / STACK_PULSE_MS)) / 2;
        stackFocusGroup?.traverse(object => {
            if (object.material?.isLineMaterial && object.userData.selectionStroke === 'yellow') {
                object.material.opacity = 0.75 + 0.25 * strength;
                object.material.linewidth = 3 + strength;
            }
        });
        return !done;
    }
    function clearStackFocus() {
        const index = frameHooks.indexOf(pulseStackFocus);
        if (index >= 0) frameHooks.splice(index, 1);
        if (!stackFocusGroup) return;
        clearGroupChildren(stackFocusGroup);
        stackFocusGroup.removeFromParent();
        stackFocusGroup = null;
        invalidateThreeView();
    }
    // Use the drawn volume, including its roof and vertical edges. Parcel provenance is not
    // the building's shape. Ground-only designs fall back to their authored boundary instead.
    function stackVolumeSegments(kind, instance) {
        if (!['built', 'designs', 'permitted'].includes(kind)) return [];
        const segments = [];
        scene.updateMatrixWorld(true);
        scene.traverseVisible(object => {
            if (!object.isMesh || !object.geometry || object.isInstancedMesh) return;
            let matches = false;
            for (let owner = object; owner && owner !== scene; owner = owner.parent) {
                const data = owner.userData || {};
                if (kind === 'designs' && String(data.proposalId || '') === String(instance.id)) matches = true;
                if (kind === 'permitted' && data.planningRepresentationId === instance.id) matches = true;
                if (kind === 'built' && data.planningBuiltFeature
                    && clickedBuildingId(data.planningBuiltFeature) === String(instance.id)) matches = true;
            }
            if (!matches) return;
            object.geometry.computeBoundingBox();
            const box = object.geometry.boundingBox;
            // Ignore the interaction slab and flat ground surfaces, even for a building design.
            if (!box || box.max.z - box.min.z < 0.5) return;
            const edges = new THREE.EdgesGeometry(object.geometry, 25);
            const positions = edges.attributes.position;
            const point = new THREE.Vector3();
            for (let i = 0; i < positions.count; i++) {
                point.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld);
                segments.push(point.x, point.y, point.z);
            }
            edges.dispose();
        });
        return segments;
    }
    // Ground designs show intent across their surface; parcel selection names only the land
    // boundary, even when both objects have exactly the same geometry. Gaps remain transparent.
    function addStackGroundHatching(group, features, instance) {
        const material = new THREE.ShaderMaterial({
            uniforms: { pixelRatio: { value: renderer.getPixelRatio() },
                selectionColor: { value: new THREE.Vector3(...window.MapHighlight.rgb()) },
                selectionHalo: { value: new THREE.Vector3(...window.MapHighlight.rgb(window.MapHighlight.halo)) } },
            vertexShader: `void main() {
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
            fragmentShader: `uniform float pixelRatio;
                uniform vec3 selectionColor;
                uniform vec3 selectionHalo;
                void main() {
                    float phase = mod((gl_FragCoord.x + gl_FragCoord.y) / pixelRatio, 12.0);
                    float distanceToStripe = min(phase, 12.0 - phase);
                    float halo = 1.0 - smoothstep(1.6, 2.4, distanceToStripe);
                    if (halo < 0.01) discard;
                    float stripe = 1.0 - smoothstep(0.6, 1.2, distanceToStripe);
                    gl_FragColor = vec4(mix(selectionHalo, selectionColor, stripe), halo * 0.7);
                }`,
            transparent: true, depthTest: false, depthWrite: false,
            side: THREE.DoubleSide, toneMapped: false
        });
        let count = 0;
        for (const feature of features) {
            for (const mesh of polygonFeatureToMeshes(feature, material, 0.55)) {
                if (realisticLayerActive) {
                    const positions = mesh.geometry.attributes.position;
                    let complete = true;
                    for (let i = 0; i < positions.count; i++) {
                        const height = window.PhotorealMode.selectionHeightAt(positions.getX(i), positions.getY(i), 'designs', instance.id);
                        if (typeof height !== 'number' || !Number.isFinite(height)) { complete = false; break; }
                        positions.setZ(i, positions.getZ(i) + height);
                    }
                    if (!complete) { mesh.geometry.dispose(); continue; }
                    mesh.geometry.computeBoundingSphere();
                }
                markOwnedMaterial(mesh, material);
                mesh.userData.selectionHatch = true;
                mesh.renderOrder = 9997;
                mesh.raycast = () => {};
                mesh.onBeforeRender = () => { material.uniforms.pixelRatio.value = renderer.getPixelRatio(); };
                group.add(mesh);
                count++;
            }
        }
        if (!count) material.dispose();
        return count > 0;
    }
    function highlightStackObject(kind, instance) {
        clearStackFocus();
        if (!scene || !instance) return;
        let segments = stackVolumeSegments(kind, instance);
        const representation = segments.length ? 'volume' : 'ground';
        const groundFeatures = representation === 'ground' ? window.ClickStackHits.featuresFor(kind, instance) : [];
        if (!segments.length) {
            const temporaryMaterial = new THREE.LineBasicMaterial();
            for (const feature of groundFeatures) {
                const lines = ['Polygon', 'MultiPolygon'].includes(feature.geometry.type)
                    ? polygonFeatureToBorderLines(feature, temporaryMaterial, 0.6)
                    : [lineFeatureToLine(feature, temporaryMaterial, 0.6)].filter(Boolean);
                for (const line of lines) {
                    const positions = line.geometry.attributes.position;
                    for (let i = 1; i < positions.count; i++) {
                        for (const index of [i - 1, i]) segments.push(positions.getX(index), positions.getY(index), positions.getZ(index));
                    }
                    line.geometry.dispose();
                }
            }
            temporaryMaterial.dispose();
        }
        if (realisticLayerActive && representation === 'ground') {
            segments = window.__threeClickPlan.drapeSegments(segments,
                (x, y) => window.PhotorealMode.selectionHeightAt(x, y, kind, instance.id),
                8 / Math.cos(xyToLatLng(0, 0).lat * Math.PI / 180));
        }
        if (!segments.length) return;
        stackFocusGroup = new THREE.Group();
        stackFocusGroup.name = 'click-stack-focus';
        stackFocusGroup.userData = { kind, id: instance.id, representation };
        // Screen-space widths work on phones and at any zoom, unlike WebGL linewidth on
        // LineBasicMaterial. The dark halo keeps yellow legible over bright roofs and paving.
        for (const [stroke, color, linewidth] of [['halo', window.MapHighlight.haloHex, 7], ['yellow', window.MapHighlight.colorHex, 4]]) {
            const geometry = new THREE.LineSegmentsGeometry();
            geometry.setPositions(segments);
            const material = new THREE.LineMaterial({ color, linewidth, transparent: true,
                opacity: 1, depthTest: false, depthWrite: false, toneMapped: false });
            const outline = new THREE.LineSegments2(geometry, material);
            markOwnedGeometry(outline, geometry);
            markOwnedMaterial(outline, material);
            outline.userData.selectionStroke = stroke;
            outline.renderOrder = stroke === 'halo' ? 9998 : 9999;
            outline.raycast = () => {};
            stackFocusGroup.add(outline);
        }
        const hatched = kind === 'designs' && representation === 'ground'
            && addStackGroundHatching(stackFocusGroup, groundFeatures, instance);
        stackFocusGroup.userData.pattern = hatched ? 'hatch' : 'outline';
        scene.add(stackFocusGroup);
        stackFocusPulseStart = 0;
        if (!window.__reducedMotion) frameHooks.push(pulseStackFocus);
        invalidateThreeView();
    }

    // What each section means in the scene, and what fills its body.
    const clickStackAdapter = {
        activate(kind, instance, body) {
            if (!instance || !body) return;
            if (kind !== 'designs') withStackDriving(() => {
                clearIsolation();
                window.clearProposalHighlights?.();
                window.ProposalSelection?.clear?.();
            });
            if (kind === 'designs') {
                body.replaceChildren();
                clearIsolation();
                withStackDriving(() => window.selectAndHighlightProposal?.(instance.id, null, false, false, true));
                const proposal = window.proposalStorage?.getProposal?.(instance.id);
                if (proposal && updateProposalInfoPanel(proposal, getProposalParcelIdSet(proposal))) body.appendChild(parcelInfoPanelEl);
                // Editing actions use the same Design section in the map view, never a second
                // inspector floating beside this scene's figures.
                const actions = document.createElement('button');
                actions.type = 'button';
                actions.className = 'btn';
                actions.textContent = threeI18n('planningViews.proposalActions', 'Design actions');
                actions.addEventListener('click', async () => {
                    await window.requestMapMode('2d');
                    window.ClickStack.showDesign(instance.id);
                });
                body.appendChild(actions);
            } else if (kind === 'parcels' || kind === 'formed') {
                if (viewedParcelId !== instance.id) viewParcel(instance.id);
                if (updateParcelInfoPanel(instance.id)) body.appendChild(parcelInfoPanelEl);
            } else if (kind === 'built') {
                hostInspector(body);
                withStackDriving(() => window.PlanningViews.inspectBuilding(instance.feature, instance.id, { hosted: true }));
                stackInspector.selectedId = window.PlanningViews.getSelected()?.id || null;
            } else if (kind === 'permitted') {
                withStackDriving(() => window.PlanningViews.select(instance.id));
                hostInspector(body);
            }
            highlightStackObject(kind, instance);
        },
        // The section closes: its figures leave, and the inspector goes home, deselected only when
        // it still shows what the stack chose (a selection made elsewhere is that surface's).
        focus(kind, instance) { highlightStackObject(kind, instance); },
        // The Focus button: move in or out until the object fills the view, keeping heading and tilt.
        frame(kind, instance) {
            const features = window.ClickStackHits.featuresFor(kind, instance);
            if (!features.length) return false;
            frameIsolatedFeatures(features);
            return true;
        },
        release({ keepSelection = false } = {}) {
            clearStackFocus();
            parcelInfoPanelEl?.remove();
            const hosted = stackInspector;
            if (!hosted) return;
            stackInspector = null;
            hosted.el.classList.remove('is-hosted');
            if (window.PlanningViews?.getSelected()?.role === 'existing') hosted.el.hidden = true;
            hosted.parent?.insertBefore(hosted.el, hosted.next && hosted.next.parentNode === hosted.parent ? hosted.next : null);
            if (keepSelection) hosted.el.hidden = true;
            else if (hosted.selectedId && window.PlanningViews?.getSelected()?.id === hosted.selectedId) {
                withStackDriving(() => window.PlanningViews.select(null));
            }
        },
        closed() {
            deselectScene();
        },
        // The neighbour rule reads buildings and designs the way this scene keys them.
        lookups: {
            builtOnParcel: feature => buildingsOnParcel(feature).map(builtInstance),
            designsOnParcel: id => getProposalsForParcel(id).map(p => ({ id: String(proposalIdOf(p)), proposal: p })),
            parcelLabel: id => window.ThreeClickStack.parcelLabel(id),
            designLabel: proposal => proposalDisplayTitle(proposal)
        }
    };

    // The permitted massing a parcel's source records for it (planning/views.js parcelOf).
    function parcelMassingItem(parcelId) {
        try {
            return (window.PlanningViews?.getItems?.() || []).find(item => item.role === 'permitted'
                && String(item.sourceEvidence?.parcelReference?.parcelId || item.source?.parcel || '') === String(parcelId)) || null;
        } catch (_) { return null; }
    }

    function observedBuildingFeatures() {
        const observed = new Map((window.buildingFeaturePool || []).map(feature => [clickedBuildingId(feature), feature]));
        for (const building of nearbyProposalBuildings) {
            const feature = window.PlanningRepresentations.observedMeshFeature(building, observed.get(String(building.object_id)));
            if (['Polygon', 'MultiPolygon'].includes(feature?.geometry?.type)) observed.set(clickedBuildingId(feature), feature);
        }
        return [...observed.values()].filter(feature => ['Polygon', 'MultiPolygon'].includes(feature?.geometry?.type));
    }

    // The existing buildings standing on a parcel, by footprint centre (as isolation decides what
    // stays visible), each once: the Built section of a click on the parcel or a design on it.
    function buildingsOnParcel(parcelOrId) {
        const parcel = parcelOrId && typeof parcelOrId === 'object' ? parcelOrId : parcelOrId ? getParcelFeatureById(parcelOrId) : null;
        if (!parcel || !existingBuildingsGroup || typeof turf === 'undefined') return [];
        const found = new Map();
        if (realisticLayerActive) {
            for (const feature of observedBuildingFeatures()) {
                if (turf.booleanPointInPolygon(turf.centroid(feature), parcel)) found.set(clickedBuildingId(feature), feature);
            }
        }
        existingBuildingsGroup.traverse(object => {
            const data = object.userData || {};
            if (!data.planningBuiltFeature || !data.footprintLatLng) return;
            const feature = data.planningBuiltFeature;
            const key = (typeof buildingPoolFeatureKey === 'function' && buildingPoolFeatureKey(feature)) || feature.id;
            if (!key || found.has(String(key))) return;
            try { if (turf.booleanPointInPolygon(turf.point(data.footprintLatLng), parcel)) found.set(String(key), feature); } catch (_) { }
        });
        return [...found].map(([id, feature]) => ({ id, feature }));
    }

    // A building's row label: its name or address, else its footprint area, so a strip of several
    // buildings on one parcel can tell them apart.
    function builtInstance({ id, feature }) {
        let label = window.ThreeClickStack.buildingLabel(feature);
        if (!label) { try { label = CbFormat.formatArea(turf.area(feature), { maxFractionDigits: 0 }); } catch (_) { label = ''; } }
        const outcomes = window.currentBuildingOutcomeState?.();
        return { id, label, feature, demolition: outcomes?.demolishedById.get(String(id)) || null };
    }

    function clickedBuildingId(feature) {
        return feature ? String((typeof buildingPoolFeatureKey === 'function' && buildingPoolFeatureKey(feature)) || feature.id || 'built') : null;
    }

    // The ground a click reaches, as the stack lists it: formed land (a live piece a design made,
    // or a piece cut from a cadastral parcel) under Formed, else the cadastral parcel under Parcel.
    function groundInstance(parcelId) {
        const stackApi = window.ThreeClickStack;
        const feature = getParcelFeatureById(parcelId);
        const props = feature?.properties || {};
        const producerId = props.producedByProposalId != null && String(props.producedByProposalId) !== '' ? String(props.producedByProposalId) : null;
        const sources = Array.isArray(props.cadastreParcelIds) ? props.cadastreParcelIds.map(String) : [];
        const instance = { id: String(parcelId), label: stackApi.parcelLabel(parcelId), feature };
        if (!producerId && !(sources.length && !sources.includes(String(parcelId)))) return { kind: 'parcels', instance };
        const producer = producerId ? window.proposalStorage?.getProposal?.(producerId) : null;
        return { kind: 'formed', instance: { ...instance, designId: producerId, designLabel: producer ? proposalDisplayTitle(producer) : producerId } };
    }

    // After a click has done its scene work: the stack for what it stood on, the clicked thing open.
    function showClickStack(picked, plan, click = null, hits = null) {
        const stackApi = window.ThreeClickStack;
        if (!stackApi) return;
        const store = window.proposalStorage;
        const parcelId = plan.parcel?.id || null;
        const ground = parcelId ? groundInstance(parcelId) : null;
        const designs = [];
        if (plan.proposal) { const clicked = store?.getProposal?.(plan.proposal.id); if (clicked) designs.push(clicked); }
        if (parcelId) designs.push(...getProposalsForParcel(parcelId));
        for (const hit of hits?.designs || []) {
            const proposal = store?.getProposal?.(hit.id);
            if (proposal) designs.push(proposal);
        }
        const massingIds = [picked?.planningId, parcelId ? parcelMassingItem(parcelId)?.id : null,
            ...(hits?.permitted || []).map(item => item.id)].filter(Boolean);
        const items = window.PlanningViews?.getItems?.() || [];
        const built = picked?.builtFeature || null;
        const builtId = clickedBuildingId(built);
        const builtList = [...(built ? [{ id: builtId, feature: built }] : []), ...buildingsOnParcel(parcelId), ...(hits?.built || [])];
        const input = {
            built: builtList.map(builtInstance),
            designs: designs.map(p => ({ id: String(proposalIdOf(p)), label: proposalDisplayTitle(p), proposal: p,
                preserveView: plan.preserveView === true })),
            permitted: massingIds.map(id => ({ id, label: items.find(item => item.id === id)?.title || '' })),
            formed: [...(ground?.kind === 'formed' ? [ground.instance] : []), ...(hits?.formed || [])],
            parcels: [...(ground?.kind === 'parcels' ? [ground.instance] : []), ...(hits?.parcels || [])]
        };
        const focus = plan.focus || (plan.proposal ? 'designs'
            : stackApi.focusOf({ ...(picked && !picked.proposalId ? picked : {}), formed: ground?.kind === 'formed' }));
        const selected = plan.selected || { ...(plan.proposal ? { designs: plan.proposal.id } : {}), ...(builtId ? { built: builtId } : {}) };
        stackApi.show(input, { focus, selected, click, container: document.getElementById('map-container') || document.body }, clickStackAdapter);
    }

    function showThreeModeDesign(key, parcelId = null, { preserveView = false } = {}) {
        if (!isActive) return false;
        const proposal = window.proposalStorage?.getProposal?.(key);
        if (!proposal) return false;
        const id = String(proposalIdOf(proposal));
        const parcel = parcelId || [...getProposalParcelIdSet(proposal)][0] || null;
        withStackDriving(() => showClickStack({ proposalId: id }, {
            proposal: { id }, parcel: parcel ? { id: String(parcel) } : null, preserveView
        }));
        return true;
    }

    function showThreeModePlan(instance, { agreement = null } = {}) {
        if (!isActive) return false;
        window.AgreementPanel?.close();
        window.ThreeClickStack.show({ plans: [instance], planContext: instance, designs: instance.members, agreements: agreement ? [agreement] : [], agreementContext: agreement },
            { focus: agreement ? 'agreements' : 'plans', selected: { plans: instance.id, ...(agreement ? { agreements: agreement.id } : {}) }, container: document.getElementById('map-container') || document.body }, clickStackAdapter);
        return agreement ? window.ThreeClickStack.ready() : true;
    }

    // A reload for a new release reopens the stack the person had open, with the same instances,
    // keeping the camera the address restored. False until the scene holds all of them again.
    function resumeThreeModeStack({ selected, expanded }) {
        if (!isActive || !sceneReady) return false;
        const designId = selected.designs || null;
        if (designId && !window.proposalStorage?.getProposal?.(designId)) return false;
        const parcelId = selected.parcels || selected.formed || null;
        if (parcelId && !getParcelFeatureById(parcelId)) return false;
        let builtFeature = null;
        if (selected.built) {
            builtFeature = (window.buildingFeaturePool || []).find(feature => clickedBuildingId(feature) === selected.built) || null;
            if (!builtFeature) return false;
        }
        const chosen = { ...selected };
        if (chosen.formed) { chosen.parcels = chosen.formed; delete chosen.formed; }
        const focus = expanded === 'formed' ? 'parcels' : expanded;
        withStackDriving(() => showClickStack({ builtFeature, planningId: selected.permitted || null }, {
            proposal: designId ? { id: designId } : null, parcel: parcelId ? { id: parcelId } : null,
            preserveView: true, focus: focus || undefined, selected: chosen
        }));
        return true;
    }
    window.resumeThreeModeStack = resumeThreeModeStack;

    function showThreeModeParcel(parcelId) {
        if (!isActive || !parcelId) return false;
        withStackDriving(() => showClickStack(null, { parcel: { id: String(parcelId) } }));
        return true;
    }

    function showThreeModeBuilding(feature, key = null) {
        if (!isActive || !feature?.geometry) return false;
        const id = String(key || clickedBuildingId(feature));
        withStackDriving(() => showClickStack({ builtFeature: feature }, { inspectBuilding: feature, builtId: id }));
        return true;
    }

    // The scene rebuilt under an open Design or Parcel section: its figures may have changed.
    function refreshClickStackFigures() {
        const expanded = window.ThreeClickStack?.expanded?.();
        if (['designs', 'parcels', 'formed'].includes(expanded)) window.ThreeClickStack.refresh();
    }

    // Isolation is entered by a click, but exited by clicking "somewhere else" — which nothing on
    // screen said. The banner names the view and carries an explicit way out.
    function ensureIsolationBanner() {
        if (!threeContainer) return null;
        if (isolationBannerEl && isolationBannerEl.parentElement === threeContainer) return isolationBannerEl;
        isolationBannerEl = document.createElement('div');
        isolationBannerEl.className = 'three-mode-isolation-banner';
        isolationBannerEl.style.display = 'none';
        const label = document.createElement('span');
        label.className = 'isolation-banner-label';
        isolationBannerEl.appendChild(label);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'close-circle-btn isolation-banner-close';
        close.innerHTML = '&times;';
        close.setAttribute('aria-label', threeI18n('threeMode.isolation.exitAria', 'Exit this view'));
        close.addEventListener('click', () => deselectScene());
        isolationBannerEl.appendChild(close);
        threeContainer.appendChild(isolationBannerEl);
        return isolationBannerEl;
    }

    function updateIsolationButton() {
        const isolated = isolatedParcelId !== null || isolatedProposalId !== null;
        try {
            if (isolationResetEl) isolationResetEl.style.display = isolated ? '' : 'none';
        } catch (_) { }
        try {
            const banner = ensureIsolationBanner();
            if (banner) {
                banner.style.display = isolated ? '' : 'none';
                const label = banner.querySelector('.isolation-banner-label');
                if (label) {
                    label.textContent = isolatedProposalId !== null
                        ? threeI18n('threeMode.isolation.proposalView', 'Design view')
                        : threeI18n('threeMode.isolation.singleParcel', 'Single parcel view');
                }
            }
        } catch (_) { }
    }

    function ensureBuildingModeControls() {
        const layersHost = document.getElementById('model-layer-controls');
        if (!threeContainer || !layersHost) return;
        if (buildingModeControlsEl && buildingModeControlsEl.parentElement === layersHost) return;

        buildingModeControlsEl = document.createElement('div');
        buildingModeControlsEl.className = 'three-mode-ui-panel';
        buildingModeControlsEl.setAttribute('role', 'group');
        buildingModeControlsEl.setAttribute('aria-label', threeI18n('threeMode.controls.buildingRenderingAria', 'Building rendering'));

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
        radiusValue.textContent = CbFormat.formatLength(buildingLoadRadiusM, { maxFractionDigits: 0 });
        radiusHeader.appendChild(radiusLabel);
        radiusHeader.appendChild(radiusValue);

        const radiusSlider = document.createElement('input');
        radiusSlider.type = 'range';
        radiusSlider.className = 'three-mode-radius-slider';
        radiusSlider.min = String(BUILDING_RADIUS_MIN_M);
        radiusSlider.max = String(BUILDING_RADIUS_MAX_M);
        radiusSlider.step = '50';
        radiusSlider.value = String(buildingLoadRadiusM);
        radiusSlider.title = threeI18n('threeMode.controls.radiusTooltip', 'Radius — how wide a band of surrounding real buildings is loaded and shown as context');
        radiusSlider.setAttribute('aria-label', radiusSlider.title);
        let hovered = false;
        let dragging = false;
        let focused = false;
        const updateRadiusPreview = () => showBuildingRadiusPreview(Number(radiusSlider.value), hovered || dragging || focused);
        stopBuildingRadiusPreview = () => {
            hovered = dragging = focused = false;
            showBuildingRadiusPreview(Number(radiusSlider.value), false);
        };
        radiusRow.addEventListener('pointerenter', () => { hovered = true; updateRadiusPreview(); });
        radiusRow.addEventListener('pointerleave', () => { hovered = false; updateRadiusPreview(); });
        radiusSlider.addEventListener('focus', () => { focused = true; updateRadiusPreview(); });
        radiusSlider.addEventListener('blur', () => { focused = false; updateRadiusPreview(); });
        radiusSlider.addEventListener('pointerdown', event => {
            dragging = true;
            radiusSlider.setPointerCapture(event.pointerId);
            updateRadiusPreview();
        });
        radiusSlider.addEventListener('lostpointercapture', () => { dragging = false; updateRadiusPreview(); });
        radiusSlider.addEventListener('pointercancel', () => { dragging = false; updateRadiusPreview(); });
        // Live label and map circle while dragging; only refetch on release ('change').
        radiusSlider.addEventListener('input', () => {
            radiusValue.textContent = CbFormat.formatLength(Number(radiusSlider.value), { maxFractionDigits: 0 });
            updateRadiusPreview();
        });
        radiusSlider.addEventListener('change', () => { setBuildingLoadRadius(Number(radiusSlider.value)); });

        radiusRow.appendChild(radiusHeader);
        radiusRow.appendChild(radiusSlider);
        buildingModeControlsEl.appendChild(radiusRow);

        // Building visibility and representation choices live in the shared planning controls.

        const facadeRow = document.createElement('div');
        facadeRow.className = 'three-mode-emphasis-row';
        const facadeLabel = document.createElement('label');
        facadeLabel.className = 'three-mode-trees-toggle three-mode-facade-label';
        facadeLabel.title = threeI18n('threeMode.controls.facadesTooltip',
            'Illustrative windows and materials on proposed buildings. Each building keeps its design.');
        facadeCheckbox = document.createElement('input');
        facadeCheckbox.id = 'three-mode-facades';
        facadeCheckbox.type = 'checkbox';
        facadeCheckbox.addEventListener('change', () => setFacadeAppearance(facadeCheckbox.checked));
        const facadeText = document.createElement('span');
        facadeText.className = 'three-mode-emphasis-label';
        facadeText.textContent = threeI18n('threeMode.controls.facades', 'Facades');
        facadeLabel.append(facadeCheckbox, facadeText);
        facadeStyleSelect = document.createElement('select');
        facadeStyleSelect.id = 'three-mode-facade-style';
        facadeStyleSelect.className = 'three-mode-display-select';
        facadeStyleSelect.setAttribute('aria-label', threeI18n('threeMode.controls.facadeStyle', 'Facade style'));
        facadeStyleSelect.title = threeI18n('threeMode.controls.facadeStyleTooltip', 'Mixed assigns a style independently to each building; glass is used only at 10+ storeys. Other presets apply to every building.');
        ['mixed', ...buildingFacades.STYLES.map(style => style.id)].forEach(id => {
            const option = document.createElement('option');
            option.value = id;
            option.textContent = threeI18n('threeMode.controls.facadeStyles.' + id, id);
            facadeStyleSelect.appendChild(option);
        });
        facadeStyleSelect.addEventListener('change', () => setFacadeAppearance(facadesEnabled, facadeStyleSelect.value));
        facadeRow.append(facadeLabel, facadeStyleSelect);
        buildingModeControlsEl.appendChild(facadeRow);
        facadeNote = document.createElement('div');
        facadeNote.className = 'three-mode-facade-note';
        facadeNote.textContent = threeI18n('threeMode.controls.facadesNote', 'Illustrative designs for proposed buildings.');
        buildingModeControlsEl.appendChild(facadeNote);
        setFacadeAppearance(facadesEnabled, facadeStyle, false);

        const xrayRow = document.createElement('div');
        xrayRow.className = 'three-mode-xray-row';
        xrayRow.setAttribute('aria-label', threeI18n('threeMode.controls.xraySection', 'X-ray floor plans'));
        xrayButton = document.createElement('button');
        xrayButton.type = 'button';
        xrayButton.id = 'three-mode-xray';
        xrayButton.className = 'btn three-mode-xray-button';
        xrayButton.textContent = threeI18n('threeMode.controls.xray', 'X-ray');
        xrayButton.title = threeI18n('threeMode.controls.xrayTooltip',
            'Show modelled floors, walls, doors and windows.');
        xrayButton.addEventListener('click', () => setXrayEnabled(!xrayEnabled));
        const xrayButtons = document.createElement('div');
        xrayButtons.className = 'three-mode-xray-buttons';
        xrayButtons.appendChild(xrayButton);
        // Only meaningful inside X-ray: generated default interiors for buildings without evidence.
        suggestedPlansButton = document.createElement('button');
        suggestedPlansButton.type = 'button';
        suggestedPlansButton.id = 'three-mode-suggested-layouts';
        suggestedPlansButton.className = 'btn three-mode-xray-button';
        suggestedPlansButton.textContent = threeI18n('threeMode.controls.suggestedLayouts', 'Suggested layouts');
        suggestedPlansButton.title = threeI18n('threeMode.controls.suggestedLayoutsTooltip',
            'Generate a default layout for proposed buildings without a modelled interior: a stair and lift core entered from the street side, two apartments per core. A suggestion, not part of the proposal.');
        suggestedPlansButton.addEventListener('click', () => setSuggestedPlansEnabled(!suggestedPlansEnabled));
        xrayButtons.appendChild(suggestedPlansButton);
        xrayRow.appendChild(xrayButtons);
        // Existing buildings get typical layouts by era, a guess from footprint and height.
        suggestedExistingRow = document.createElement('label');
        suggestedExistingRow.className = 'three-mode-trees-toggle three-mode-wide-toggle three-mode-suggested-existing';
        suggestedExistingCheckbox = document.createElement('input');
        suggestedExistingCheckbox.type = 'checkbox';
        suggestedExistingCheckbox.id = 'three-mode-suggested-existing';
        suggestedExistingCheckbox.checked = suggestedExistingEnabled;
        suggestedExistingCheckbox.addEventListener('change', () => setSuggestedExistingEnabled(suggestedExistingCheckbox.checked));
        const suggestedExistingText = document.createElement('span');
        suggestedExistingText.className = 'three-mode-emphasis-label';
        suggestedExistingText.textContent = threeI18n('threeMode.controls.suggestedExisting', 'Existing buildings too');
        suggestedExistingRow.title = threeI18n('threeMode.controls.suggestedExistingTooltip',
            'Also show typical layouts by era for the existing buildings around: a guess from footprint and height, not a survey.');
        suggestedExistingRow.setAttribute('aria-label', suggestedExistingRow.title);
        suggestedExistingRow.append(suggestedExistingCheckbox, suggestedExistingText);
        const suggestedExistingHost = document.createElement('div');
        suggestedExistingHost.setAttribute('data-map-modes', '3d');
        suggestedExistingHost.appendChild(suggestedExistingRow);
        xrayRow.appendChild(suggestedExistingHost);
        floorCutawayControl = document.createElement('label');
        floorCutawayControl.className = 'three-mode-floor-cutaway';
        const cutawayLabel = document.createElement('span');
        cutawayLabel.textContent = threeI18n('threeMode.controls.floorCutaway', 'Cut above');
        floorCutawaySelect = document.createElement('select');
        floorCutawaySelect.id = 'three-mode-floor-cutaway';
        floorCutawaySelect.className = 'three-mode-display-select';
        floorCutawaySelect.setAttribute('aria-label', threeI18n('threeMode.controls.floorCutawayTooltip', 'Choose which floors remain visible in X-ray view'));
        floorCutawaySelect.title = floorCutawaySelect.getAttribute('aria-label');
        floorCutawayControl.title = floorCutawaySelect.title;
        floorCutawaySelect.addEventListener('change', () => {
            setFloorCutaway(floorCutawaySelect.value === 'all' ? null : Number(floorCutawaySelect.value));
        });
        floorCutawayControl.append(cutawayLabel, floorCutawaySelect);
        xrayRow.appendChild(floorCutawayControl);
        xrayNote = document.createElement('div');
        xrayNote.id = 'three-mode-xray-note';
        xrayNote.className = 'three-mode-xray-note';
        xrayNote.setAttribute('role', 'status');
        xrayButton.setAttribute('aria-describedby', xrayNote.id);
        xrayRow.appendChild(xrayNote);
        updateXrayControls();

        // Scenery toggles — populated dynamically from GET /decor/layers (see refreshDecorToggles),
        // so a checkbox appears only for layers the current city has actually ingested (e.g. Trees for
        // Belgrade, nothing for cities without scenery). Independent of the Built/Planned mode.
        decorTogglesEl = document.createElement('div');
        decorTogglesEl.className = 'three-mode-decor-toggles';
        buildingModeControlsEl.appendChild(decorTogglesEl);

        // Plots an applied urban rule left out — see-through volumes showing what each would carry.
        // Not a city scenery layer, so it is not fetched from /decor/layers: every city can have one.
        // Its own row with nothing beside it, so the label uses the panel's full width instead of
        // wrapping into a two-line stub.
        const ineligibleRow = document.createElement('div');
        ineligibleRow.className = 'three-mode-trees-row three-mode-wide-row';
        const ineligibleLabel = document.createElement('label');
        ineligibleLabel.className = 'three-mode-trees-toggle three-mode-wide-toggle';
        const ineligibleBox = document.createElement('input');
        ineligibleBox.type = 'checkbox';
        ineligibleBox.checked = showIneligibleParcels;
        ineligibleBox.addEventListener('change', () => {
            showIneligibleParcels = ineligibleBox.checked;
            try { rebuild3DBuildingsOnly(); } catch (_) { }
        });
        const ineligibleText = document.createElement('span');
        ineligibleText.className = 'three-mode-emphasis-label';
        ineligibleText.textContent = threeI18n('threeMode.controls.ineligibleParcels', 'Non-buildable plots');
        ineligibleLabel.title = threeI18n('threeMode.controls.ineligibleParcelsTooltip', 'Show transparent volumes where the current applied rule leaves no buildable plot; this does not mean the land is universally unbuildable.');
        ineligibleLabel.setAttribute('aria-label', ineligibleLabel.title);
        ineligibleLabel.appendChild(ineligibleBox);
        ineligibleLabel.appendChild(ineligibleText);
        ineligibleRow.appendChild(ineligibleLabel);
        buildingModeControlsEl.appendChild(ineligibleRow);

        // Schematic people and vehicles: a frontend-only layer every city can show, so it is not
        // fetched from /decor/layers either. Same row shape as the plots toggle above.
        lifeEnabled = loadLifeEnabledPref();
        const lifeRow = document.createElement('div');
        lifeRow.className = 'three-mode-trees-row three-mode-wide-row';
        const lifeLabel = document.createElement('label');
        lifeLabel.className = 'three-mode-trees-toggle three-mode-wide-toggle';
        const lifeBox = document.createElement('input');
        lifeBox.type = 'checkbox';
        lifeBox.checked = lifeEnabled;
        lifeBox.addEventListener('change', () => setLifeEnabled(lifeBox.checked));
        const lifeText = document.createElement('span');
        lifeText.className = 'three-mode-emphasis-label';
        lifeText.textContent = threeI18n('threeMode.controls.life', 'People and traffic');
        lifeLabel.title = threeI18n('threeMode.controls.lifeTooltip', 'Show or hide schematic people and vehicles moving through the 3D view');
        lifeLabel.setAttribute('aria-label', lifeLabel.title);
        lifeLabel.appendChild(lifeBox);
        lifeLabel.appendChild(lifeText);
        lifeRow.appendChild(lifeLabel);
        buildingModeControlsEl.appendChild(lifeRow);
        lifeToggleEl = lifeBox;

        // Ground: the asphalt roadbed under every street and pavement everywhere else, derived
        // from the same OSM streets the vehicles drive (three-ground.js). Same row shape again.
        groundEnabled = loadGroundEnabledPref();
        const groundRow = document.createElement('div');
        groundRow.className = 'three-mode-trees-row three-mode-wide-row';
        const groundLabel = document.createElement('label');
        groundLabel.className = 'three-mode-trees-toggle three-mode-wide-toggle';
        const groundBox = document.createElement('input');
        groundBox.type = 'checkbox';
        groundBox.checked = groundEnabled;
        groundBox.addEventListener('change', () => setGroundEnabled(groundBox.checked));
        const groundText = document.createElement('span');
        groundText.className = 'three-mode-emphasis-label';
        groundText.textContent = threeI18n('threeMode.controls.ground', 'Streets and pavement');
        groundLabel.title = threeI18n('threeMode.controls.groundTooltip', 'Show or hide the asphalt roadbed and pavement derived from OpenStreetMap under the 3D view');
        groundLabel.setAttribute('aria-label', groundLabel.title);
        groundLabel.appendChild(groundBox);
        groundLabel.appendChild(groundText);
        groundRow.appendChild(groundLabel);
        buildingModeControlsEl.appendChild(groundRow);
        groundToggleEl = groundBox;

        // Where the context buildings came from, and how many heights are estimates (OSM).
        buildingsSourceNoteEl = document.createElement('p');
        buildingsSourceNoteEl.className = 'three-mode-source-note';
        buildingsSourceNoteEl.hidden = true;
        const sourceNoteHost = document.createElement('div');
        sourceNoteHost.setAttribute('data-map-modes', '3d');
        sourceNoteHost.appendChild(buildingsSourceNoteEl);
        buildingModeControlsEl.appendChild(sourceNoteHost);
        updateBuildingsSourceNote();
        // Keep X-ray as a clearly separated final section after scenery and plot diagnostics.
        buildingModeControlsEl.appendChild(xrayRow);

        // These layers describe the flat model context. Google supplies its own ground and
        // existing scenery; proposed-building appearance and inspection work in both views.
        [radiusRow, decorTogglesEl, lifeRow, groundRow].forEach(row => row.setAttribute('data-map-modes', '3d'));

        layersHost.appendChild(buildingModeControlsEl);
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
        const features = [];
        try {
            (proposalStorage.getAllProposals() || []).forEach(p => {
                // Shared arrivals resolve publication rows before entering this local selection.
                if (p?.proposalId == null || !focusIds.has(String(p.proposalId))) return;
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
        // A bent clipping ribbon can survive vertex cleanup and extrude into duplicate walls.
        const hasArea = points => meshSanitize.hasRenderableArea(points.map(v => [v.x, v.y, 0]), EPS);
        if (!hasArea(outer)) return null;
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
            if (hasArea(holePts)) shape.holes.push(new THREE.Path(holePts));
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
            markOwnedGeometry(mesh, geometry);
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
                markOwnedGeometry(loop, g);
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
            const line = new THREE.Line(g, material);
            markOwnedGeometry(line, g);
            return line;
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
        } else if (descriptor?.kind === 'parcel-layout') {
            (descriptor.plots || []).forEach(plot => push(plot && plot.geometry));
        } else {
            push(descriptor?.geometry);
        }
        if (!features.length && draft?.fields?.selectedParcelIds?.length) {
            draft.fields.selectedParcelIds.map(String).forEach(id => {
                push(window.LiveParcelFabric?.get?.(id));
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
        const definition = proposal?.roadProposal?.definition;
        push(definition?.polygon);
        (proposal?.buildingProposal?.buildings || proposal?.geometry?.buildings || []).forEach(push);
        push(proposal?.buildingProposal?.buildingFeature);
        if (!features.length && proposal?.buildingGeometry) push({ type: 'Feature', properties: proposal.buildingProperties || {}, geometry: proposal.buildingGeometry });
        (proposal?.parcelLayout?.plots || []).forEach(plot => push(plot && plot.geometry));
        push(proposal?.structureProposal?.geometry);
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

    function addDraftPreviewFeature3D(feature, target, style, kind, options = {}) {
        if (!feature?.geometry || !target) return;
        if (kind === 'buildings' && feature.properties?.modelUrl && typeof options.isCurrent === 'function') {
            placeUploadedModel(feature, target, buildingMaterials.ghost, {
                isCurrent: options.isCurrent,
                fitToFootprint: true,
                cloneGeometry: true
            });
            return;
        }
        const color = { source: 0x64748b, envelope: 0x996600, excluded: 0x9a3412, draft: 0x2563eb }[style];
        const opacity = { source: 0.2, envelope: 0.10, excluded: 0.28, draft: 0.55 }[style];
        const fill = new THREE.MeshLambertMaterial({
            color,
            transparent: true,
            opacity,
            depthWrite: style === 'draft',
            polygonOffset: true,
            polygonOffsetFactor: -5,
            polygonOffsetUnits: -5,
            side: THREE.DoubleSide
        });
        const line = new THREE.LineBasicMaterial({ color, transparent: true, opacity: style === 'source' ? 0.55 : 1, depthTest: true, depthWrite: false });
        if (feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString') {
            const object = lineFeatureToLine(feature, line, style === 'source' ? 0.35 : 0.55);
            if (object) { markOwnedMaterial(object, line); object.renderOrder = style === 'source' ? 9100 : 9200; target.add(object); }
            return;
        }
        const height = kind === 'buildings' ? estimateBuildingHeightMeters(feature) : 0;
        let meshes = polygonFeatureToMeshes(feature, fill, style === 'source' ? 0.22 : 0.38, height);
        // Only the actual procedural building proposal gets a facade skin. Permitted envelopes,
        // excluded plots, source/comparison geometry and green/road surfaces retain their own
        // materials. Uploaded models return through placeUploadedModel above with authored mats.
        if (style === 'draft' && kind === 'buildings' && !feature.properties?.modelUrl) {
            try {
                const point = feature.geometry.type === 'MultiPolygon'
                    ? feature.geometry.coordinates[0][0][0] : feature.geometry.coordinates[0][0];
                const metresPerUnit = Math.cos(point[1] * Math.PI / 180);
                const ruleFloorHeight = feature.properties?.urbanRule?.floorHeightM;
                const floorHeight = typeof ruleFloorHeight === 'number' && Number.isFinite(ruleFloorHeight) && ruleFloorHeight > 0
                    ? ruleFloorHeight : (window.STOREY_HEIGHT_M || 3.3);
                const city = window.CityConfigManager?.getCurrentCityId?.() || '';
                meshes = prepareProceduralFacadeMeshes(meshes, feature, height, floorHeight, metresPerUnit, city, true);
            } catch (_) { /* Keep the basic 3D preview if optional facade setup fails. */ }
        }
        meshes
            .forEach(mesh => { markOwnedMaterial(mesh, fill); mesh.renderOrder = style === 'source' ? 9100 : 9200; target.add(mesh); });
        polygonFeatureToBorderLines(feature, line, Math.max(0.5, height + 0.5))
            .forEach(border => { markOwnedMaterial(border, line); border.renderOrder = style === 'source' ? 9101 : 9201; target.add(border); });
    }

    function activeOnMapEditorPreviewDetail() {
        const editor = window.OnMapEditor;
        if (!editor || typeof editor.isActive !== 'function' || typeof editor.getPreview !== 'function') return null;
        try { return editor.isActive() ? (editor.getPreview() || null) : null; } catch (_) { return null; }
    }

    function addOnMapEditorContextPreview3D(detail, target) {
        if (!detail || !target) return;
        const surface = detail.groundSurface;
        if (surface?.polygon) {
            const material = new THREE.MeshLambertMaterial({
                color: surface.treatment === 'green' ? 0x4f8b55 : 0x8a8d91,
                transparent: true,
                opacity: 0.3,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: -4,
                polygonOffsetUnits: -4,
                side: THREE.DoubleSide
            });
            const feature = { type: 'Feature', properties: {}, geometry: surface.polygon };
            if (surface.decorationDesign) {
                feature.properties.decorations = window.ProposalApplyStructures.decorationsOnGround(surface.decorationDesign, surface.polygon, turf);
                if (surface.treatment === 'green') buildParks3D(target, target, [feature]);
                else buildSquares3D(target, target, [feature], buildingSidewalkMaterial());
            }
            polygonFeatureToMeshes(feature, material, 0.035, 0).forEach(mesh => {
                markOwnedMaterial(mesh, material);
                mesh.renderOrder = 9190;
                target.add(mesh);
            });
        }
        (detail.envelopes || []).forEach(feature => addDraftPreviewFeature3D(feature, target, 'envelope', 'buildings'));
        (detail.excluded || []).forEach(feature => addDraftPreviewFeature3D(feature, target, 'excluded', 'buildings'));
        if (detail.boundary?.geometry) {
            const material = new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.9, depthWrite: false });
            polygonFeatureToBorderLines(detail.boundary, material, 0.12).forEach(border => {
                markOwnedMaterial(border, material);
                border.renderOrder = 9195;
                target.add(border);
            });
        }
    }

    function resolvedProposalDraftPreviewDetail(detail, editorDetail) {
        if (!editorDetail?.draftPreview) return detail || null;
        // The live map editor owns the preview while it is open. The comparison detail stays
        // cached so it can be restored as soon as that editor closes.
        return { draftPreview: editorDetail.draftPreview, onMapEditor: editorDetail };
    }

    function rebuildProposalDraftPreview3D(detail = latestProposalDraftPreviewDetail) {
        latestProposalDraftPreviewDetail = detail || null;
        const modelPreviewGeneration = ++onMapEditorModelPreviewGeneration;
        if (!isActive || !proposalDraftGroup) return;
        disposeDraftPreviewChildren(proposalDraftGroup);
        const editorDetail = activeOnMapEditorPreviewDetail();
        const previewDetail = resolvedProposalDraftPreviewDetail(latestProposalDraftPreviewDetail, editorDetail);
        if (!previewDetail) { invalidateThreeView(); return; }
        const sourceGroup = new THREE.Group();
        const draftGroup = new THREE.Group();
        proposalDraftGroup.add(sourceGroup, draftGroup);
        if (previewDetail.sourceProposal) {
            collectSourcePreviewFeatures(previewDetail.sourceProposal)
                .forEach(feature => addDraftPreviewFeature3D(feature, sourceGroup, 'source', 'source'));
        }
        if (previewDetail.draftPreview) {
            if (previewDetail.onMapEditor) addOnMapEditorContextPreview3D(previewDetail.onMapEditor, draftGroup);
            const draft = previewDetail.onMapEditor ? null : (window.proposalDraftStore?.getDraft?.(previewDetail.draftId) || null);
            const modelPreviewOptions = previewDetail.onMapEditor ? {
                isCurrent: () => modelPreviewGeneration === onMapEditorModelPreviewGeneration
                    && !!activeOnMapEditorPreviewDetail()
                    && draftGroup.parent === proposalDraftGroup
            } : {};
            collectDraftPreviewFeatures(previewDetail.draftPreview, draft)
                .forEach(feature => addDraftPreviewFeature3D(feature, draftGroup, 'draft', previewDetail.draftPreview.kind, modelPreviewOptions));
        }
        invalidateThreeView();
    }

    function handleOnMapEditorPreviewChange() {
        // Read the current editor state here rather than retaining event.detail: the event's null
        // close notification means "restore the general preview", and late-loaded 3D gets the same
        // result by asking the editor directly during scene construction.
        rebuildProposalDraftPreview3D(latestProposalDraftPreviewDetail);
    }

    function mapSelectionBlockedByEditor() {
        try { return window.__mapEditLock?.blocksSelection?.() === true; } catch (_) { return false; }
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
        return ['roadProposal', 'buildingProposal', 'structureProposal', 'parcelLayout']
            .some(k => proposal[k] && isApplied(proposal, proposal[k]));
    }

    function proposalParcelFeatures3D(proposal) {
        const fabric = window.LiveParcelFabric;
        if (!proposal || !fabric) return [];
        const produced = proposal.proposalId && typeof fabric.producedBy === 'function'
            ? fabric.producedBy(proposal.proposalId)
            : [];
        if (produced.length) return produced;
        return typeof fabric.entriesForCadastre === 'function'
            ? fabric.entriesForCadastre(proposal.cadastreParcelIds || [])
            : [];
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
            // A parcel layout is land-administration scaffolding under the whole plan: its
            // pick surface blanketed the area and intercepted clicks meant for the buildings
            // standing on it. It stays selectable from lists/panels, never from map clicks.
            if (proposal.parcelLayout && !proposal.buildingProposal && !proposal.structureProposal
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
                    || proposal.cadastreParcelIds?.[0] || null;
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
                                    markOwnedMaterial(object, object.material);
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
        applyParcelEmphasis();
    }

    // Park lawns and green proposal ground: the procedural grass pattern (three-grass.js), in true
    // metres over the Mercator-inflated scene XY.
    function lawnMaterial() {
        const grass = window.__threeGrass;
        if (!grass) throw new Error('three-grass.js is not loaded');
        return grass.grassTexture(new THREE.MeshLambertMaterial({
            color: grass.COLORS.lawn, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
        }), 1 / lifeMercatorK(), 'lawn');
    }

    function buildParks3D(flatTarget, decoTarget, features = null) {
        const parks = features || displayedFeatures((typeof window !== 'undefined' && Array.isArray(window.parks)) ? window.parks : []);
        if (!parks || parks.length === 0) return;
        // Use polygonOffset to float slightly over base to avoid z-fighting and flicker
        const grassMat = lawnMaterial();
        const waterMat = new THREE.MeshPhongMaterial({ color: 0x2b6cb0, specular: 0x1f3a60, shininess: 40, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
        const pathLineMat = new THREE.LineBasicMaterial({ color: 0xdfe8d6, depthTest: true, depthWrite: false });

        const isCurrentModel = startStructureModels(decoTarget);
        parks.forEach(p => {
            try {
                if (!p || !p.geometry) return;
                // Under construction: the lawn spreads with progress; trees and furniture come when built.
                const site = buildoutSiteOf(p.properties?.proposalId);
                if (site) { addBuildoutGround3D(flatTarget, p, grassMat, site, { ownCover: true }); return; }
                // Ground at slight z offset (an uploaded model replaces it)
                placeStructureModel(p, decoTarget, isCurrentModel, () => {
                    const groundMeshes = polygonFeatureToMeshes(p, grassMat, 0.06, 0);
                    groundMeshes.forEach(m => { markOwnedMaterial(m, grassMat); m.userData.isParkGround = true; flatTarget.add(m); });
                });

                // Draw ponds (slightly above ground)
                const deco = (p.properties && p.properties.decorations) ? p.properties.decorations : null;
                if (deco && Array.isArray(deco.ponds)) {
                    deco.ponds.forEach(ring => {
                        try {
                            const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
                            const waterMeshes = polygonFeatureToMeshes(feature, waterMat, 0.065, 0);
                            waterMeshes.forEach(m => { markOwnedMaterial(m, waterMat); flatTarget.add(m); });
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
                                markOwnedMaterial(line, pathLineMat);
                                // The path's height clears the park surface; buildings still occlude it.
                                line.renderOrder = 9999;
                                // If it's a Group (MultiLineString), apply to children
                                if (line.isGroup) {
                                    line.traverse(obj => {
                                        if (obj.isLine) {
                                            obj.renderOrder = 9999;
                                        }
                                    });
                                }
                                decoTarget.add(line);
                            }
                        } catch (_) { }
                    });
                }

                // Flowerbeds: a raised bed of dark soil inside a stone edging, planted with leafy
                // clumps in coloured rings (park-planting.js decides where every plant goes).
                if (deco && Array.isArray(deco.flowerbeds)) {
                    deco.flowerbeds.forEach(ring => {
                        try { addFlowerbed3D(flatTarget, decoTarget, ring); } catch (error) {
                            console.warn('[3D] flowerbed failed; skipping one bed', error);
                        }
                    });
                }

                // Fenced areas: a dog or play area's ground, and every fence with its gates.
                if (deco && Array.isArray(deco.enclosures) && deco.enclosures.length) {
                    try { addParkEnclosures3D(flatTarget, decoTarget, p, deco.enclosures); } catch (error) {
                        console.error(`[${new Date().toISOString()}] [3D] fenced areas of park ${p.properties?.proposalId} failed; drawn without them`, error);
                    }
                }

                // Benches: user-placed first-class objects (same as trees); an uploaded bench model
                // replaces the default bench for all of them.
                const models = deco?.models || null;
                if (deco && Array.isArray(deco.benches)) {
                    placeFurniture3D('bench', deco.benches, models, decoTarget, isCurrentModel, spots => addProceduralBenches3D(decoTarget, spots));
                }
                if (deco) placeFurniture3D('stall', deco.stalls, models, decoTarget, isCurrentModel, spots => addMarketStalls3D(decoTarget, spots));
                placeLamps3D(deco?.lamps, models, decoTarget, isCurrentModel);
                if (deco) {
                    for (const [kind, key] of Object.entries(parkEnclosuresApi().EQUIPMENT)) {
                        if (Array.isArray(deco[key]) && deco[key].length) placeFurniture3D(kind, deco[key], models, decoTarget, isCurrentModel, spots => addPlayEquipment3D(decoTarget, kind, spots));
                    }
                }

                // Trees: the STORED trees are the truth — auto-generated and user-placed alike
                // (the old random sampling ignored edits, so a repositioned tree never moved in
                // 3D), each with its stored look. Random sampling remains only for legacy parks
                // without tree data.
                const storedTrees = (deco && Array.isArray(deco.trees)) ? deco.trees.filter(entry => {
                    const coord = parkPlanting().treeCoordinate(entry);
                    if (!coord) return false;
                    try { return turf.booleanPointInPolygon(turf.point(coord), p); } catch (_) { return true; }
                }) : [];
                if (storedTrees.length) {
                    placeFurniture3D('tree', storedTrees, models, decoTarget, isCurrentModel, spots => addParkTrees3D(decoTarget, spots.map(spot => spot.item)));
                } else {
                    let area = 0; try { area = turf.area(p); } catch (_) { }
                    const count = Math.max(3, Math.min(60, Math.round(area / 2000)));
                    let bbox = null; try { bbox = turf.bbox(p); } catch (_) { }
                    if (!bbox) return;
                    const sampled = [];
                    let safety = 0;
                    while (sampled.length < count && safety < count * 20) {
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
                        sampled.push([rnd.geometry.coordinates[0], rnd.geometry.coordinates[1]]);
                    }
                    addParkTrees3D(decoTarget, sampled);
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
                stone: new THREE.MeshLambertMaterial({ color: 0xc9c9c2 })
            };
        }
        return furnitureMats;
    }

    function parkPlanting() {
        const api = window.__parkPlanting;
        if (!api) throw new Error('park-planting.js is not loaded');
        return api;
    }

    // ---- Tree species (tree-species.js): every tree in the model view is one of eight procedural
    // species, one shared unit-height geometry each, drawn as one InstancedMesh per species per group.
    function treeSpeciesApi() {
        const api = window.TreeSpecies;
        if (!api) throw new Error('tree-species.js is not loaded');
        return api;
    }

    // Shared, never disposed: the species geometries and their one vertex-coloured material.
    let speciesAssets = null;
    function ensureSpeciesAssets() {
        if (speciesAssets) return speciesAssets;
        const api = treeSpeciesApi();
        const geometries = {};
        api.SPECIES_IDS.forEach(id => {
            const data = api.buildSpecies(id);
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
            geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
            geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
            geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
            geometry.computeBoundingSphere();
            geometries[id] = geometry;
        });
        speciesAssets = { geometries, shared: new Set(Object.values(geometries)), material: new THREE.MeshLambertMaterial({ vertexColors: true }) };
        return speciesAssets;
    }

    // Writes one tree look ({ x, y, z, heightM, yaw, tint }, scene XY, metric Z) into slot `index`.
    const speciesDummy = { object: null, color: null };
    function setSpeciesInstance(mesh, index, look, k) {
        const dummy = speciesDummy.object || (speciesDummy.object = new THREE.Object3D());
        const color = speciesDummy.color || (speciesDummy.color = new THREE.Color());
        dummy.position.set(look.x, look.y, look.z || 0);
        dummy.rotation.set(0, 0, look.yaw);
        dummy.scale.set(look.heightM * k, look.heightM * k, look.heightM);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
        mesh.setColorAt(index, color.setRGB(look.tint[0], look.tint[1], look.tint[2], THREE.LinearSRGBColorSpace));
    }

    // Species meshes sized for `looks` (one per species present), each with every look of its species
    // written in. Returns { [species]: InstancedMesh }; the caller adds and owns them.
    function speciesTreeMeshes(looks) {
        const assets = ensureSpeciesAssets();
        const k = lifeMercatorK();
        const bySpecies = new Map();
        looks.forEach(look => {
            if (!bySpecies.has(look.species)) bySpecies.set(look.species, []);
            bySpecies.get(look.species).push(look);
        });
        const meshes = {};
        bySpecies.forEach((list, species) => {
            const mesh = new THREE.InstancedMesh(assets.geometries[species], assets.material, list.length);
            list.forEach((look, index) => setSpeciesInstance(mesh, index, look, k));
            mesh.count = list.length;
            mesh.instanceMatrix.needsUpdate = true;
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
            mesh.userData.decorationKind = 'tree';
            mesh.userData.treeSpecies = species;
            meshes[species] = mesh;
        });
        return meshes;
    }

    // Park and square trees as their stored look names them (park-planting.js treeOf: kind, height);
    // the region chooses the species of that kind. `entries` are stored trees or bare [lng, lat].
    function addParkTrees3D(target, entries, z = FURNITURE_GROUND_Z) {
        const species = treeSpeciesApi();
        const looks = [];
        entries.forEach(entry => {
            const tree = parkPlanting().treeOf(entry);
            if (!tree) return;
            const [lng, lat] = tree.coordinate;
            const [x, y] = latLngToXY(lat, lng);
            looks.push({ x, y, z, ...species.treeInstance(lng, lat, { kind: tree.kind, heightM: tree.heightM }) });
        });
        Object.values(speciesTreeMeshes(looks)).forEach(mesh => target.add(ownInstances(mesh)));
    }

    // Pavement trees' pits (park-planting.js TREE_PITS): per square, one merged mesh per pit kind,
    // just above the paving and laid square to the square's longest edge. A grille is a cast-iron
    // grate with soil showing through; grass and soil pits get a stone edge.
    const TREE_PIT_LIFT_M = 0.012;          // above the paving (FURNITURE_GROUND_Z, declared further down)
    const TREE_PIT_EDGE_M = 0.1;
    let treePitAssets = null; // shared, never disposed: the grille, soil and edge materials
    function ensureTreePitAssets() {
        if (treePitAssets) return treePitAssets;
        const size = 128, mid = size / 2;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const c = canvas.getContext('2d');
        c.fillStyle = '#4a3a2c';
        c.fillRect(0, 0, size, size);
        c.strokeStyle = '#34373b';
        c.lineWidth = 10;
        c.strokeRect(5, 5, size - 10, size - 10);
        c.lineWidth = 4;
        [24, 38, 52].forEach(r => c.strokeRect(mid - r, mid - r, r * 2, r * 2));
        for (let i = 0; i < 8; i++) {
            const a = i * Math.PI / 4;
            c.beginPath();
            c.moveTo(mid + Math.cos(a) * 16, mid + Math.sin(a) * 16);
            c.lineTo(mid + Math.cos(a) * 60, mid + Math.sin(a) * 60);
            c.stroke();
        }
        c.lineWidth = 5;
        c.beginPath();
        c.arc(mid, mid, 17, 0, Math.PI * 2);
        c.stroke();
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        treePitAssets = {
            grille: new THREE.MeshLambertMaterial({ map: texture }),
            soil: new THREE.MeshLambertMaterial({ color: 0x5b4332 }),
            edge: new THREE.MeshLambertMaterial({ color: 0x9c978b })
        };
        return treePitAssets;
    }

    function addTreePits3D(target, trees, site) {
        const planting = parkPlanting();
        const pits = (Array.isArray(trees) ? trees : []).map(entry => planting.treeOf(entry)).filter(tree => tree?.pit);
        if (!pits.length) return;
        const geometry = site?.geometry;
        const ring = geometry?.type === 'Polygon' ? geometry.coordinates[0] : (geometry?.type === 'MultiPolygon' ? geometry.coordinates[0]?.[0] : null);
        const bearing = planting.longestEdgeBearing(ring);
        const k = lifeMercatorK();
        const half = planting.PIT_SIZE_M / 2 * k;
        const quads = { grille: [], grass: [], soil: [], edge: [] };
        const square = (list, corners) => list.push(corners);
        pits.forEach(tree => {
            const [x, y] = latLngToXY(tree.coordinate[1], tree.coordinate[0]);
            square(quads[tree.pit], planting.pitCorners(x, y, half, bearing));
            if (tree.pit === 'grille') return;
            // The stone edge: four strips just outside the pit.
            const outer = planting.pitCorners(x, y, half + TREE_PIT_EDGE_M * k, bearing);
            const inner = planting.pitCorners(x, y, half, bearing);
            for (let i = 0; i < 4; i++) {
                const j = (i + 1) % 4;
                square(quads.edge, [outer[i], outer[j], inner[j], inner[i]]);
            }
        });
        Object.entries(quads).forEach(([kind, list]) => {
            if (!list.length) return;
            const positions = new Float32Array(list.length * 12);
            const uvs = new Float32Array(list.length * 8);
            const indices = [];
            list.forEach((corners, q) => {
                corners.forEach(([x, y], i) => positions.set([x, y, FURNITURE_GROUND_Z + TREE_PIT_LIFT_M], q * 12 + i * 3));
                uvs.set([0, 0, 1, 0, 1, 1, 0, 1], q * 8);
                indices.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
            });
            const buffer = new THREE.BufferGeometry();
            buffer.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            buffer.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
            buffer.setIndex(indices);
            buffer.computeVertexNormals();
            const material = kind === 'grass' ? lawnMaterial() : ensureTreePitAssets()[kind];
            const mesh = new THREE.Mesh(buffer, material);
            markOwnedGeometry(mesh, buffer);
            if (kind === 'grass') markOwnedMaterial(mesh, material);
            mesh.userData.treePit = kind;
            target.add(mesh);
        });
    }

    // Shared, never disposed: unit shapes the flowerbed instances scale (like the OSM tree assets).
    let flowerbedAssets = null;
    function ensureFlowerbedAssets() {
        if (flowerbedAssets) return flowerbedAssets;
        const kerb = new THREE.BoxGeometry(1, 1, 1);
        kerb.translate(0.5, 0, 0.5); // runs from its start point along +X, standing on z = 0
        flowerbedAssets = {
            kerb,
            clump: new THREE.SphereGeometry(1, 7, 5),
            blossom: new THREE.IcosahedronGeometry(1, 0),
            kerbMat: new THREE.MeshLambertMaterial({ color: 0xb8b2a3 }),
            soilMat: new THREE.MeshLambertMaterial({ color: 0x4a3426, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
            leafMat: new THREE.MeshLambertMaterial({ color: 0xffffff }),
            blossomMat: new THREE.MeshLambertMaterial({ color: 0xffffff })
        };
        return flowerbedAssets;
    }

    // A flowerbed: raised soil, a low stone edging along its ring, and its plants as two instanced
    // meshes (leafy clumps and blossoms) so a bed of hundreds of plants costs a handful of draws.
    function addFlowerbed3D(flatTarget, decoTarget, ring) {
        const FLOWERBED_GROUND_Z = 0.06, SOIL_DEPTH = 0.14, KERB_WIDTH = 0.14, KERB_HEIGHT = 0.24;
        const assets = ensureFlowerbedAssets();
        const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
        polygonFeatureToMeshes(feature, assets.soilMat, FLOWERBED_GROUND_Z, SOIL_DEPTH).forEach(m => flatTarget.add(m));
        const soilTop = FLOWERBED_GROUND_Z + SOIL_DEPTH;

        const xy = ring.map(coordsToXY);
        const dummy = new THREE.Object3D();
        const edges = xy.length - 1;
        if (edges > 0) {
            const kerbs = new THREE.InstancedMesh(assets.kerb, assets.kerbMat, edges);
            for (let i = 0; i < edges; i++) {
                const [ax, ay] = xy[i], [bx, by] = xy[i + 1];
                dummy.position.set(ax, ay, FLOWERBED_GROUND_Z);
                dummy.rotation.set(0, 0, Math.atan2(by - ay, bx - ax));
                // A touch longer than the edge so the corners of a curved ring close.
                dummy.scale.set(Math.hypot(bx - ax, by - ay) + KERB_WIDTH * 0.5, KERB_WIDTH, KERB_HEIGHT);
                dummy.updateMatrix();
                kerbs.setMatrixAt(i, dummy.matrix);
            }
            kerbs.instanceMatrix.needsUpdate = true;
            decoTarget.add(kerbs);
        }

        const plants = parkPlanting().flowerbedPlanting(xy, parkPlanting().ringSeed(ring));
        if (!plants.length) return;
        const clumps = new THREE.InstancedMesh(assets.clump, assets.leafMat, plants.length);
        const blooming = plants.filter(plant => plant.color !== null);
        const blossoms = blooming.length ? new THREE.InstancedMesh(assets.blossom, assets.blossomMat, blooming.length) : null;
        const color = new THREE.Color();
        let bloomIndex = 0;
        plants.forEach((plant, index) => {
            dummy.rotation.set(0, 0, (plant.x * 7.1 + plant.y * 3.3) % (Math.PI * 2));
            dummy.position.set(plant.x, plant.y, soilTop + plant.heightM * 0.45);
            dummy.scale.set(plant.radiusM, plant.radiusM, plant.heightM * 0.55);
            dummy.updateMatrix();
            clumps.setMatrixAt(index, dummy.matrix);
            // Leaf greens vary a little from plant to plant.
            color.setHSL(0.28 + ((index * 37) % 10) * 0.006, 0.55, 0.24 + ((index * 53) % 10) * 0.012);
            clumps.setColorAt(index, color);
            if (plant.color === null) return;
            const bloomR = plant.radiusM * 0.62;
            dummy.position.set(plant.x, plant.y, soilTop + plant.heightM + bloomR * 0.3);
            dummy.scale.set(bloomR, bloomR, bloomR * 0.6);
            dummy.updateMatrix();
            blossoms.setMatrixAt(bloomIndex, dummy.matrix);
            blossoms.setColorAt(bloomIndex, color.setHex(plant.color));
            bloomIndex += 1;
        });
        clumps.instanceMatrix.needsUpdate = true;
        if (clumps.instanceColor) clumps.instanceColor.needsUpdate = true;
        decoTarget.add(clumps);
        if (blossoms) {
            blossoms.instanceMatrix.needsUpdate = true;
            if (blossoms.instanceColor) blossoms.instanceColor.needsUpdate = true;
            decoTarget.add(blossoms);
        }
    }

    // The default bench: seat slab + backrest + legs, each part one InstancedMesh for all benches of
    // a structure, every bench turned to its bearing (degrees from north; furniturePlacements).
    let benchParts = null;
    function addProceduralBenches3D(target, spots) {
        if (!benchParts) {
            // Shared, never disposed, like the flowerbed and lamp assets.
            const part = (w, d, h, x, y, z) => { const geometry = new THREE.BoxGeometry(w, d, h); geometry.translate(x, y, z); return geometry; };
            benchParts = [
                part(1.7, 0.55, 0.1, 0, 0, 0.45),
                part(1.7, 0.08, 0.5, 0, -0.28, 0.75),
                part(0.08, 0.45, 0.45, -0.7, 0, 0.22),
                part(0.08, 0.45, 0.45, 0.7, 0, 0.22)
            ];
        }
        const placements = furniturePlacements(spots);
        benchParts.forEach(geometry => {
            const mesh = ownInstances(new THREE.InstancedMesh(geometry, furnitureMaterials().wood, placements.length));
            placements.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
            mesh.instanceMatrix.needsUpdate = true;
            target.add(mesh);
        });
    }

    function parkEnclosuresApi() {
        const api = window.ParkEnclosures;
        if (!api) throw new Error('park-enclosures.js is not loaded');
        return api;
    }

    // Fences, enclosure grounds and play equipment share these, never disposed, like the flowerbeds'.
    let enclosureAssets = null;
    function ensureEnclosureAssets() {
        if (enclosureAssets) return enclosureAssets;
        const lambert = color => new THREE.MeshLambertMaterial({ color });
        const ground = color => new THREE.MeshLambertMaterial({ color, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
        enclosureAssets = {
            box: new THREE.BoxGeometry(1, 1, 1),
            fence: {
                timber: lambert(0x8a5a2b), metal: lambert(0x2f4f3a), iron: lambert(0x1c1c1c), brick: lambert(0x9a4b35), stone: lambert(0xc9c4b8),
                // Mesh infill is see-through: what stands behind the fence stays visible.
                mesh: new THREE.MeshLambertMaterial({ color: 0x2f4f3a, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide })
            },
            surface: { gravel: ground(0xcdbf9f), rubber: ground(0xb8573f) },
            play: { frame: lambert(0x1f6fb2), seat: lambert(0x262626), chain: lambert(0x9aa0a6), wood: lambert(0xa0703c), chute: lambert(0xf2b632) },
            playParts: new Map()
        };
        return enclosureAssets;
    }

    // A park's fenced areas (park-enclosures.js): the gravel or rubber ground of a dog or play area,
    // then every fence as boxes (posts, rails, bars, mesh, brick plinth) split at its gates, one
    // InstancedMesh per material for the whole park. Box sizes along the ground are in scene units
    // (true metres x k), heights in metres.
    function addParkEnclosures3D(flatTarget, decoTarget, park, list) {
        const api = parkEnclosuresApi(), assets = ensureEnclosureAssets(), k = lifeMercatorK();
        const boxes = [];
        list.forEach(enclosure => {
            const ring = api.enclosureRing(enclosure, park.geometry);
            if (!ring) return;
            const surface = api.USE_SURFACE[enclosure.use];
            if (surface) {
                const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
                polygonFeatureToMeshes(feature, assets.surface[surface], 0.063, 0).forEach(mesh => flatTarget.add(mesh));
            }
            const runs = api.fenceRuns(ring, enclosure.gates).runs.map(run => run.map(([lng, lat]) => latLngToXY(lat, lng)));
            boxes.push(...api.fenceParts(runs, enclosure.fence, k));
        });
        const byMaterial = new Map();
        boxes.forEach(part => { if (!byMaterial.has(part.material)) byMaterial.set(part.material, []); byMaterial.get(part.material).push(part); });
        const dummy = new THREE.Object3D();
        byMaterial.forEach((parts, material) => {
            const mesh = ownInstances(new THREE.InstancedMesh(assets.box, assets.fence[material], parts.length));
            parts.forEach((part, index) => {
                dummy.position.set(part.x, part.y, FURNITURE_GROUND_Z + part.z);
                dummy.rotation.set(0, 0, part.angle);
                dummy.scale.set(part.along, part.across, part.height);
                dummy.updateMatrix();
                mesh.setMatrixAt(index, dummy.matrix);
            });
            mesh.instanceMatrix.needsUpdate = true;
            decoTarget.add(mesh);
        });
    }

    // The default swing, seesaw and slide (park-enclosures.js EQUIPMENT_PARTS): each part one
    // InstancedMesh for every item of that kind in the park, turned to its bearing like the benches.
    function addPlayEquipment3D(target, kind, spots) {
        const assets = ensureEnclosureAssets();
        if (!assets.playParts.has(kind)) {
            assets.playParts.set(kind, (parkEnclosuresApi().EQUIPMENT_PARTS[kind] || []).map(part => {
                const geometry = new THREE.BoxGeometry(part.sx, part.sy, part.sz);
                geometry.rotateY(part.ry || 0);
                geometry.translate(part.x, part.y, part.z);
                return { geometry, material: assets.play[part.material] };
            }));
        }
        const placements = furniturePlacements(spots);
        assets.playParts.get(kind).forEach(({ geometry, material }) => {
            const mesh = ownInstances(new THREE.InstancedMesh(geometry, material, placements.length));
            placements.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
            mesh.instanceMatrix.needsUpdate = true;
            target.add(mesh);
        });
    }

    // The default market stall (furniture-models.js): four posts, a counter on the side its bearing
    // faces (the model's +X) and a striped canopy. Per structure that is one InstancedMesh each for the
    // posts, the counters and the canopies; each canopy takes its stall's colour (stallColor) as an
    // instance colour multiplied over one shared white/grey stripe texture, so every colour is one draw.
    let marketStallAssets = null;
    const MARKET_STALL_POSTS = [[-0.75, -1.15], [-0.75, 1.15], [0.75, -1.15], [0.75, 1.15]];
    function ensureMarketStallAssets() {
        if (marketStallAssets) return marketStallAssets;
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 8;
        const context = canvas.getContext('2d');
        for (let stripe = 0; stripe < 8; stripe++) {
            context.fillStyle = stripe % 2 ? '#d9d9d9' : '#ffffff';
            context.fillRect(stripe * 8, 0, 8, 8);
        }
        const stripes = new THREE.CanvasTexture(canvas);
        stripes.colorSpace = THREE.SRGBColorSpace;
        stripes.magFilter = THREE.NearestFilter;
        const post = new THREE.BoxGeometry(0.07, 0.07, 2.4);
        post.translate(0, 0, 1.2);
        const counter = new THREE.BoxGeometry(0.6, 2.4, 0.95);
        counter.translate(0.5, 0, 0.475);
        // The canopy slopes down toward the counter side.
        const canopy = new THREE.BoxGeometry(1.95, 2.6, 0.05);
        canopy.rotateY(0.2);
        canopy.translate(0, 0, 2.45);
        marketStallAssets = {
            post, counter, canopy,
            postMat: new THREE.MeshLambertMaterial({ color: 0x5b4636 }),
            counterMat: new THREE.MeshLambertMaterial({ color: 0xb08a5c }),
            canopyMat: new THREE.MeshLambertMaterial({ color: 0xffffff, map: stripes, side: THREE.DoubleSide })
        };
        return marketStallAssets;
    }

    function addMarketStalls3D(target, spots) {
        const assets = ensureMarketStallAssets();
        const placements = furniturePlacements(spots);
        const posts = ownInstances(new THREE.InstancedMesh(assets.post, assets.postMat, placements.length * MARKET_STALL_POSTS.length));
        const counters = ownInstances(new THREE.InstancedMesh(assets.counter, assets.counterMat, placements.length));
        const canopies = ownInstances(new THREE.InstancedMesh(assets.canopy, assets.canopyMat, placements.length));
        const offset = new THREE.Matrix4();
        const matrix = new THREE.Matrix4();
        const color = new THREE.Color();
        placements.forEach((placement, index) => {
            MARKET_STALL_POSTS.forEach(([x, y], post) => {
                posts.setMatrixAt(index * MARKET_STALL_POSTS.length + post, matrix.multiplyMatrices(placement, offset.makeTranslation(x, y, 0)));
            });
            counters.setMatrixAt(index, placement);
            canopies.setMatrixAt(index, placement);
            canopies.setColorAt(index, color.set(furnitureApi().stallColor(spots[index].item, index)));
        });
        [posts, counters, canopies].forEach(mesh => { mesh.instanceMatrix.needsUpdate = true; });
        if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
        target.add(posts, counters, canopies);
    }

    // A statue: stone pedestal + simple standing figure.
    function addStatue3D(target, lng, lat) {
        const [x, y] = latLngToXY(lat, lng);
        const stone = furnitureMaterials().stone;
        const pedGeo = new THREE.BoxGeometry(1.4, 1.4, 1.0);
        pedGeo.translate(x, y, 0.06 + 0.5);
        const pedestal = new THREE.Mesh(pedGeo, stone);
        markOwnedGeometry(pedestal, pedGeo);
        target.add(pedestal);
        const bodyGeo = new THREE.CylinderGeometry(0.32, 0.45, 1.9, 10);
        bodyGeo.rotateX(Math.PI / 2);
        bodyGeo.translate(x, y, 0.06 + 1.0 + 0.95);
        const body = new THREE.Mesh(bodyGeo, stone);
        markOwnedGeometry(body, bodyGeo);
        target.add(body);
        const headGeo = new THREE.SphereGeometry(0.3, 10, 10);
        headGeo.translate(x, y, 0.06 + 1.0 + 1.9 + 0.25);
        const head = new THREE.Mesh(headGeo, stone);
        markOwnedGeometry(head, headGeo);
        target.add(head);
    }

    let squareSurfaceMats = null;
    function squareSurfaceMaterials() {
        // Rebuild if the texture never came out. The paving material is shared by squares, the
        // structure ground and the footways, so a null map cached on the first call would leave
        // every one of them flat-coloured for the rest of the session.
        if (squareSurfaceMats && squareSurfaceMats.paving && !squareSurfaceMats.paving.map) squareSurfaceMats = null;
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
    function buildSquares3D(flatTarget, decoTarget, features = null, surfaceMaterial = null) {
        const squares = features || displayedFeatures((typeof window !== 'undefined' && Array.isArray(window.squares)) ? window.squares : []);
        if (!squares || squares.length === 0) return;

        const squareMats = squareSurfaceMaterials();
        const stoneMat = surfaceMaterial || squareMats.paving;
        const rimMat = squareMats.rim;
        const waterMat = squareMats.water;

        const isCurrentModel = startStructureModels(decoTarget);
        squares.forEach(sq => {
            try {
                if (!sq || !sq.geometry) return;
                // Under construction: the paving spreads with progress; furniture comes when built.
                const site = buildoutSiteOf(sq.properties?.proposalId);
                if (site) { addBuildoutGround3D(flatTarget, sq, stoneMat, site, { ownCover: !!surfaceMaterial }); return; }
                // Ground slightly above base to avoid z-fighting (an uploaded model replaces it)
                placeStructureModel(sq, decoTarget, isCurrentModel, () => {
                    const groundMeshes = polygonFeatureToMeshes(sq, stoneMat, 0.06, 0);
                    groundMeshes.forEach(m => {
                        if (surfaceMaterial) markOwnedMaterial(m, surfaceMaterial);
                        m.userData.isSquareGround = true; flatTarget.add(m);
                    });
                    const borderLines = polygonFeatureToBorderLines(sq, squareMats.border, 0.075);
                    borderLines.forEach(line => { line.userData.isSquarePavingBorder = true; flatTarget.add(line); });
                });

                const dec = sq.properties && sq.properties.decorations;
                if (!dec) return;

                // Furniture from the geometry editor (all first-class objects there). A kind with an
                // uploaded model (decorations.models) draws that model for every item instead.
                const models = dec.models || null;
                placeFurniture3D('tree', dec.trees, models, decoTarget, isCurrentModel, spots => addParkTrees3D(decoTarget, spots.map(spot => spot.item)));
                // Pavement trees' pits draw under any tree, default or uploaded model.
                addTreePits3D(decoTarget, dec.trees, sq);
                placeFurniture3D('bench', dec.benches, models, decoTarget, isCurrentModel, spots => addProceduralBenches3D(decoTarget, spots));
                placeFurniture3D('stall', dec.stalls, models, decoTarget, isCurrentModel, spots => addMarketStalls3D(decoTarget, spots));
                placeFurniture3D('statue', dec.statues, models, decoTarget, isCurrentModel, spots => spots.forEach(spot => {
                    try { addStatue3D(decoTarget, spot.lng, spot.lat); } catch (_) { }
                }));
                placeLamps3D(dec.lamps, models, decoTarget, isCurrentModel);

                // Fountains: edited squares store an ARRAY; legacy squares a single `fountain`.
                const fountains = (Array.isArray(dec.fountains) && dec.fountains.length)
                    ? dec.fountains
                    : (Array.isArray(dec.fountain) ? [dec.fountain] : []);
                placeFurniture3D('fountain', fountains, models, decoTarget, isCurrentModel, spots => spots.forEach(spot => {
                const { lng, lat } = spot;
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
                markOwnedGeometry(pedestal, pedGeo);
                group.add(pedestal);

                // Basin rim
                const basinH = 0.2;
                const basinR = 2.0;
                const basinGeo = new THREE.CylinderGeometry(basinR, basinR, basinH, 48, 1, false);
                basinGeo.rotateX(Math.PI / 2);
                basinGeo.translate(x, y, 0.06 + pedH + basinH / 2);
                const basin = new THREE.Mesh(basinGeo, rimMat);
                markOwnedGeometry(basin, basinGeo);
                group.add(basin);

                // Water disk inside basin
                const waterR = basinR * 0.85;
                const waterGeo = new THREE.CylinderGeometry(waterR, waterR, 0.06, 48);
                waterGeo.rotateX(Math.PI / 2);
                waterGeo.translate(x, y, 0.06 + pedH + basinH + 0.03);
                const water = new THREE.Mesh(waterGeo, waterMat);
                markOwnedGeometry(water, waterGeo);
                water.renderOrder = 8000;
                group.add(water);

                // Central spout
                const spoutH = 0.8;
                const spoutR = 0.12;
                const spoutGeo = new THREE.CylinderGeometry(spoutR, spoutR, spoutH, 12);
                spoutGeo.rotateX(Math.PI / 2);
                spoutGeo.translate(x, y, 0.06 + pedH + basinH + spoutH / 2);
                const spout = new THREE.Mesh(spoutGeo, waterMat);
                markOwnedGeometry(spout, spoutGeo);
                spout.material.transparent = true;
                spout.material.opacity = 0.9;
                group.add(spout);

                decoTarget.add(group);
                }));
            } catch (_) { }
        });
    }

    // ---- Furniture models and lamps (furniture-models.js) ----
    // A park or square may give one uploaded model to every item of a furniture kind. The model is
    // loaded once (loadGltfScene's cache) and drawn as one InstancedMesh per mesh inside it, so a
    // kind costs as many draw calls as its model has meshes, however many items there are.
    const FURNITURE_GROUND_Z = 0.06;      // the park/square surface the furniture stands on
    const LAMP_HEIGHT_M = 4;              // the default lamp's pole
    const LAMP_HEAD_Z = LAMP_HEIGHT_M + 0.12;
    const LAMP_POOL_RADIUS_M = 5;         // the pool of light on the ground under a lit lamp

    function furnitureApi() {
        const api = window.FurnitureModels;
        if (!api) throw new Error('furniture-models.js is not loaded');
        return api;
    }

    // Where each item stands: { lng, lat, bearing, item }; items without a valid point are skipped.
    function furnitureSpots(kind, items) {
        return (Array.isArray(items) ? items : []).map(item => {
            const coord = kind === 'tree' ? parkPlanting().treeCoordinate(item)
                : (Array.isArray(item?.coordinate) ? item.coordinate : item);
            if (!Array.isArray(coord) || coord.length < 2) return null;
            const lng = Number(coord[0]), lat = Number(coord[1]);
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
            return { lng, lat, bearing: Number(item?.bearing) || 0, item };
        }).filter(Boolean);
    }

    // One matrix per spot: position, bearing (the model's +X faces it) and the Mercator (k, k, 1)
    // scale that turns a model in metres into scene units (FurnitureModels.instanceTransform).
    function furniturePlacements(spots) {
        const k = lifeMercatorK();
        const dummy = new THREE.Object3D();
        return spots.map(spot => {
            const [x, y] = latLngToXY(spot.lat, spot.lng);
            const transform = furnitureApi().instanceTransform({ x, y, z: FURNITURE_GROUND_Z, bearingDeg: spot.bearing, k });
            dummy.position.set(...transform.position);
            dummy.rotation.set(0, 0, transform.rotationZ);
            dummy.scale.set(...transform.scale);
            dummy.updateMatrix();
            return dummy.matrix.clone();
        });
    }

    // An InstancedMesh owns its per-instance buffers; dispose them with the structure's rebuild.
    function ownInstances(mesh) {
        threeResources.markOwned(mesh, 'geometries', { dispose: () => mesh.dispose() });
        return mesh;
    }

    // Each mesh of a loaded model with its matrix inside the model after the glTF Y-up -> scene Z-up
    // turn, centred on its footprint and standing on z = 0. Cached per source scene.
    const furnitureModelLayouts = new WeakMap();
    function furnitureModelLayout(source) {
        if (furnitureModelLayouts.has(source)) return furnitureModelLayouts.get(source);
        source.updateMatrixWorld(true);
        const upright = new THREE.Matrix4().makeRotationX(Math.PI / 2);
        const box = new THREE.Box3();
        const meshes = [];
        source.traverse(node => {
            if (!node.isMesh || !node.geometry?.attributes?.position || !node.material) return;
            const local = new THREE.Matrix4().multiplyMatrices(upright, node.matrixWorld);
            if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
            box.union(node.geometry.boundingBox.clone().applyMatrix4(local));
            meshes.push({ node, local });
        });
        let layout = null;
        if (meshes.length && !box.isEmpty()) {
            const center = box.getCenter(new THREE.Vector3());
            const ground = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -box.min.z);
            meshes.forEach(entry => entry.local.premultiply(ground));
            layout = { meshes, height: box.max.z - box.min.z };
        }
        furnitureModelLayouts.set(source, layout);
        return layout;
    }

    // Draws every spot of one kind with the model at modelUrl. Resolves with the model's layout, or
    // null when the structure was rebuilt meanwhile; rejects when the model cannot be drawn.
    function placeFurnitureInstances(kind, spots, modelUrl, decoTarget, isCurrent) {
        const url = (typeof resolveBackendAssetUrl === 'function' && resolveBackendAssetUrl(modelUrl)) || modelUrl;
        return loadGltfScene(url).then(source => {
            if (!isActive || !isCurrent()) return null;
            const layout = source ? furnitureModelLayout(source) : null;
            if (!layout) throw new Error('The furniture model has no meshes');
            const placements = furniturePlacements(spots);
            const group = new THREE.Group();
            group.userData.furnitureKind = kind;
            const matrix = new THREE.Matrix4();
            layout.meshes.forEach(({ node, local }) => {
                // Clones keep the model's textures; the source materials stay with the cache.
                const materials = (Array.isArray(node.material) ? node.material : [node.material]).map(material => material.clone());
                const material = Array.isArray(node.material) ? materials : materials[0];
                const mesh = ownInstances(new THREE.InstancedMesh(node.geometry, material, placements.length));
                placements.forEach((placement, index) => mesh.setMatrixAt(index, matrix.multiplyMatrices(placement, local)));
                mesh.instanceMatrix.needsUpdate = true;
                markOwnedMaterial(mesh, material);
                group.add(mesh);
            });
            decoTarget.add(group);
            sunLayer?.syncObjects(group);
            invalidateThreeView();
            return layout;
        });
    }

    // One furniture kind of one structure: its uploaded model when it has one, otherwise (or when the
    // model fails to load) `procedural(spots)`, the default look. `onModel(spots, layout)` adds what goes
    // with a drawn model (a lamp's glow at the model's height).
    function placeFurniture3D(kind, items, models, decoTarget, isCurrent, procedural, onModel = null) {
        const spots = furnitureSpots(kind, items);
        if (!spots.length) return;
        const url = typeof models?.[kind]?.url === 'string' ? models[kind].url : '';
        if (!url) { procedural(spots); return; }
        placeFurnitureInstances(kind, spots, url, decoTarget, isCurrent).then(layout => {
            if (layout && onModel) onModel(spots, layout);
        }, error => {
            if (!isActive || !isCurrent()) return;
            console.warn('[3D] furniture model failed to load; drawing the default', kind, url, error);
            procedural(spots);
            invalidateThreeView();
        });
    }

    // Shared, never disposed: the default lamp and the glow every lamp shares. The structure display
    // mode draws each object with its own scoped copy of a material (three-structure-refresh.js), so
    // night and day are applied to the drawn objects' materials, listed in lampGlowObjects.
    let lampAssets = null;
    const lampGlowObjects = new Set();   // pools, halos and default lamp heads in the scene
    function ensureLampAssets() {
        if (lampAssets) return lampAssets;
        const pole = new THREE.CylinderGeometry(0.06, 0.09, LAMP_HEIGHT_M, 8);
        pole.rotateX(Math.PI / 2);
        pole.translate(0, 0, LAMP_HEIGHT_M / 2);
        const head = new THREE.SphereGeometry(0.22, 12, 8);
        head.translate(0, 0, LAMP_HEAD_Z - FURNITURE_GROUND_Z);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const context = canvas.getContext('2d');
        const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
        gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
        gradient.addColorStop(0.35, 'rgba(255, 255, 255, 0.45)');
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
        context.fillStyle = gradient;
        context.fillRect(0, 0, 64, 64);
        const glow = new THREE.CanvasTexture(canvas);
        glow.colorSpace = THREE.SRGBColorSpace;
        lampAssets = {
            pole, head,
            poleMat: new THREE.MeshLambertMaterial({ color: 0x33383d }),
            headMat: new THREE.MeshLambertMaterial({ color: 0xf2ead8, emissive: 0xffd28a, emissiveIntensity: 0 }),
            pool: new THREE.CircleGeometry(1, 32),
            poolMat: new THREE.MeshBasicMaterial({
                map: glow, color: 0xffc46b, transparent: true, opacity: 0, visible: false, depthWrite: false,
                blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
            }),
            haloMat: new THREE.PointsMaterial({
                map: glow, color: 0xffd9a0, size: 2.4, sizeAttenuation: true, transparent: true, opacity: 0,
                visible: false, depthWrite: false, blending: THREE.AdditiveBlending
            })
        };
        return lampAssets;
    }

    // The default lamp: a pole and a head, each one InstancedMesh for all lamps of a structure.
    function addProceduralLamps3D(decoTarget, spots) {
        const assets = ensureLampAssets();
        const poles = ownInstances(new THREE.InstancedMesh(assets.pole, assets.poleMat, spots.length));
        const heads = ownInstances(new THREE.InstancedMesh(assets.head, assets.headMat, spots.length));
        furniturePlacements(spots).forEach((matrix, index) => {
            poles.setMatrixAt(index, matrix);
            heads.setMatrixAt(index, matrix);
        });
        poles.instanceMatrix.needsUpdate = true;
        heads.instanceMatrix.needsUpdate = true;
        heads.userData.lampGlow = 'head';
        lampGlowObjects.add(heads);
        decoTarget.add(poles, heads);
    }

    // The night glow of a structure's lamps: one Points for every head (a halo) and one InstancedMesh
    // of flat discs for the light pools on the ground. No lights; additive, never written to depth,
    // never picked.
    function addLampGlow3D(decoTarget, spots, headHeightM) {
        const assets = ensureLampAssets();
        const k = lifeMercatorK();
        const positions = new Float32Array(spots.length * 3);
        const pools = ownInstances(new THREE.InstancedMesh(assets.pool, assets.poolMat, spots.length));
        const dummy = new THREE.Object3D();
        spots.forEach((spot, index) => {
            const [x, y] = latLngToXY(spot.lat, spot.lng);
            positions[index * 3] = x;
            positions[index * 3 + 1] = y;
            positions[index * 3 + 2] = FURNITURE_GROUND_Z + headHeightM;
            dummy.position.set(x, y, FURNITURE_GROUND_Z + 0.02);
            dummy.scale.set(LAMP_POOL_RADIUS_M * k, LAMP_POOL_RADIUS_M * k, 1);
            dummy.updateMatrix();
            pools.setMatrixAt(index, dummy.matrix);
        });
        pools.instanceMatrix.needsUpdate = true;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const halos = new THREE.Points(geometry, assets.haloMat);
        markOwnedGeometry(halos, geometry);
        pools.userData.lampGlow = 'pool';
        halos.userData.lampGlow = 'halo';
        [pools, halos].forEach(object => {
            object.raycast = () => { };
            lampGlowObjects.add(object);
        });
        pools.renderOrder = 9400;
        halos.renderOrder = 9500;
        decoTarget.add(pools, halos);
    }

    function placeLamps3D(items, models, decoTarget, isCurrent) {
        placeFurniture3D('lamp', items, models, decoTarget, isCurrent, spots => {
            addProceduralLamps3D(decoTarget, spots);
            addLampGlow3D(decoTarget, spots, LAMP_HEAD_Z - FURNITURE_GROUND_Z);
        }, (spots, layout) => addLampGlow3D(decoTarget, spots, layout.height * 0.92));
    }

    // Before each render: lamps glow with the night (FurnitureModels.lampGlowStrength of the sun's
    // altitude; none while the sun layer is off). A material is written only when its value differs,
    // and this never schedules a frame of its own: the sun's own changes already invalidate the view.
    // Objects a rebuild removed (no parent) leave the list here.
    function updateLampGlow() {
        if (!lampGlowObjects.size) return;
        const altitude = window.__threeSun?.currentAltitudeDeg?.();
        const strength = furnitureApi().lampGlowStrength(typeof altitude === 'number' ? altitude : null);
        const level = Math.round(strength * 50) / 50;
        for (const object of lampGlowObjects) {
            if (!object.parent) { lampGlowObjects.delete(object); continue; }
            const role = object.userData.lampGlow;
            (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => {
                if (!material) return;
                if (role === 'head') {
                    if (material.emissiveIntensity !== 1.2 * level) material.emissiveIntensity = 1.2 * level;
                    return;
                }
                const opacity = (role === 'pool' ? 0.55 : 0.9) * level;
                if (material.opacity !== opacity) material.opacity = opacity;
                if (material.visible !== level > 0) material.visible = level > 0;
            });
        }
    }

    // Before each render, like the lamps: the sky follows the sun (a neutral light gradient while the
    // sun layer is off; hidden in photo view, whose tiles bring their own sky) and windows light up
    // over the same dusk ramp as the lamps. Both write uniforms only when something changed, and
    // never schedule a frame of their own.
    let sky = null;   // three-sky.js dome and stars of the current scene
    function updateSkyAndWindows() {
        const sun = window.__threeSun?.currentSun?.() || null;
        sky?.update(sun, !!window.PhotorealMode?.isActive?.());
        const night = furnitureApi().lampGlowStrength(sun ? sun.altitudeDeg : null);
        nightWindows.setState(nightWindowState, night, lifeMercatorK());
        lifeLayer?.setNight(night);
    }

    function buildingSidewalkMaterial() {
        ensureGroundLayer();
        return window.__threeSiteGround.sidewalkMaterial(THREE, groundLayer, 1 / lifeMercatorK());
    }

    // Building ground keeps sidewalk paving even when it carries square-editor furniture.
    // Merely choosing a treatment never generates a furniture layout. See building-ground.js.
    // Designs' grounds go into their own 'DesignGrounds' child, which the build-out redraws alone
    // (`vacant: false`) while the vacant plots stay.
    function buildProposalGrounds3D(groundTarget, { vacant = true } = {}) {
        if (vacant) window.__threeSiteGround.buildVacantPlots({
            THREE, target: groundTarget,
            features: window.vacantLayoutPlots({ features: sceneParcelSnapshot, existingBuildings: standingBuildingFootprints3D() }),
            polygonMeshes: polygonFeatureToMeshes, project: coordsToXY, metresPerUnit: 1 / lifeMercatorK(),
            ownMaterial: markOwnedMaterial, ownGeometry: markOwnedGeometry
        });
        const flatTarget = new THREE.Group();
        flatTarget.name = 'DesignGrounds';
        groundTarget.add(flatTarget);
        const api = (typeof window !== 'undefined') ? window.BuildingGround : null;
        if (!api || typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') return;
        let surfaces = [];
        try {
            surfaces = api.appliedSurfaces(displayedProposals(), isApplied);
            const editingId = window.OnMapEditor?.isActive() ? window.getActiveProposalDesignDraft?.()?.sourceLocalProposalId : null;
            if (editingId) surfaces = surfaces.filter(surface => surface.proposalId !== editingId);
        } catch (error) {
            console.error('[three-mode] building ground surfaces could not be collected', error);
            return;
        }
        if (!surfaces.length) return;

        const pavingMat = buildingSidewalkMaterial();
        const grassMat = lawnMaterial();
        surfaces.forEach(surface => {
            try {
                const site = buildoutSiteOf(surface.proposalId);
                if (site) {
                    // A design's ground is laid with its building; until then it is graded earth.
                    addBuildoutGround3D(flatTarget, { type: 'Feature', properties: { proposalId: surface.proposalId }, geometry: surface.geometry },
                        surface.treatment === 'paved' ? pavingMat : grassMat, { ...site, progress: 0 });
                    return;
                }
                const feature = { type: 'Feature', properties: {}, geometry: surface.geometry };
                // Parcels are private: their boundaries across the open ground are fenced.
                const fences = window.buildingGroundFences?.(surface) || [];
                if (fences.length) {
                    const fence = window.__threeSiteGround.buildFence({ THREE, geometry: { type: 'MultiLineString', coordinates: fences },
                        project: coordsToXY, metresPerUnit: 1 / lifeMercatorK(), ownMaterial: markOwnedMaterial, ownGeometry: markOwnedGeometry });
                    fence.userData.isProposalGroundFence = true;
                    flatTarget.add(fence);
                }
                if (surface.decorationDesign) {
                    feature.properties.decorations = window.ProposalApplyStructures.decorationsOnGround(surface.decorationDesign, surface.geometry, turf);
                    if (surface.treatment === 'green') buildParks3D(flatTarget, flatTarget, [feature]);
                    else buildSquares3D(flatTarget, flatTarget, [feature], pavingMat);
                    return;
                }
                const material = surface.treatment === 'paved' ? pavingMat : grassMat;
                polygonFeatureToMeshes(feature, material, 0.06, 0).forEach(mesh => {
                    markOwnedMaterial(mesh, material);
                    mesh.userData.isProposalGround = true;
                    flatTarget.add(mesh);
                });
            } catch (error) {
                console.error('[three-mode] failed to build a proposal ground surface', surface.proposalId, error);
            }
        });
    }

    // The existing buildings this scene draws, as ground footprints for the vacant-plot rule: the
    // same /buildings/near band and the same demolition verdicts as the meshes, never the 2D pool,
    // which holds only what earlier 2D viewports happened to fetch. Always the normal state: the
    // build-out (displayedProposals) does not redraw vacant plots.
    function standingBuildingFootprints3D() {
        const proposals = (typeof proposalStorage !== 'undefined' && proposalStorage.getAllProposals()) || [];
        const carveRecords = window.collectCarveRecords(
            proposals,
            {
                consolidateCorridorRecords: (records, region) =>
                    window.consolidateCorridorDemolitionRecords(records, region, window.turf),
                consolidateBuildingRecords: records =>
                    window.consolidateBuildingDemolitionRecords(records, window.turf)
            }
        );
        const structureRegions = collectAppliedStructureClearanceRegions(proposals);
        return window.__threeSiteGround.standingBuildingFootprints(nearbyProposalBuildings,
            bld => window.carveBuildingByObjectId(bld.object_id, carveRecords) || structureClearanceCarve(bld, structureRegions), turf);
    }

    // The vacant-plot ground depends on which existing buildings stand in the band, so it follows
    // the nearby-buildings response. Before the scene is ready, initScene's own build sees the data.
    function rebuildProposalGrounds3D() {
        if (!isActive || !sceneReady || !proposalGroundGroup) return;
        clearGroupChildren(proposalGroundGroup);
        try { buildProposalGrounds3D(proposalGroundGroup); } catch (error) { console.error('[three-mode] proposal grounds rebuild failed', error); }
        applyModeVisibility();
        invalidateThreeView();
    }

    // Only the designs' grounds, keeping the vacant plots (the build-out's phase changes).
    function rebuildDesignGrounds3D() {
        if (!proposalGroundGroup) return;
        const previous = proposalGroundGroup.getObjectByName('DesignGrounds');
        if (previous) { clearGroupChildren(previous); proposalGroundGroup.remove(previous); }
        try { buildProposalGrounds3D(proposalGroundGroup, { vacant: false }); } catch (error) { console.error('[three-mode] design grounds rebuild failed', error); }
    }

    // Build Lakes (shore + water + fish)
    function buildLakes3D(flatTarget, decoTarget) {
        const lakes = displayedFeatures((typeof window !== 'undefined' && Array.isArray(window.lakes)) ? window.lakes : []);
        if (!lakes || lakes.length === 0) return;

        const shoreMat = new THREE.MeshLambertMaterial({ color: 0xf3d7a0 });
        const transitionMat = new THREE.MeshLambertMaterial({ color: 0x3c92d6 });
        const waterMat = new THREE.MeshPhongMaterial({ color: 0x3fa7f5, specular: 0x1b6fa8, shininess: 50, transparent: true, opacity: 0.88 });
        const fishMat = new THREE.MeshLambertMaterial({ color: 0xffa500 });

        const isCurrentModel = startStructureModels(decoTarget);
        lakes.forEach(lake => {
            try {
                if (!lake || !lake.geometry) return;
                // Under construction: the water spreads with progress over the dug basin.
                const site = buildoutSiteOf(lake.properties?.proposalId);
                if (site) { addBuildoutGround3D(flatTarget, lake, waterMat, site, { ownCover: true }); return; }

                // An uploaded model replaces the basin (shore, shelf, water and fish).
                const buildBasin = () => {
                    // Ensure lake graphics are generated
                    try {
                        if (typeof ensureLakeGraphics === 'function') ensureLakeGraphics(lake);
                    } catch (_) { }

                    const graphics = lake.properties && lake.properties.lakeGraphics;
                    let basin;
                    try {
                        basin = window.__threeLakeBasin.partitionLakeBasin(lake.geometry, graphics,
                            (operation, a, b) => window.__parcelArrangement.clip(operation, a, b,
                                { site: 'three-mode.lakeBasin', proposalId: lake.properties?.proposalId }));
                    } catch (error) {
                        reportThreeClip('difference', error, 'three-mode.lakeBasin', [lake]);
                        return;
                    }
                    const shoreGeom = basin.shore;
                    const waterGeom = basin.water;
                    const transitionGeom = basin.transition;

                    // RECESSED basin: the parcel ground has the lake footprint cut out (see
                    // buildParcels3D), so the lake digs below grade instead of floating above it.
                    const SHELF_Z = -0.7;   // shallow shelf
                    const WATER_Z = -1.4;   // water surface depth
                    // Sandy beach stays at grade, as a solid going down to the water depth so its
                    // outer face closes the pit wall where it meets the surrounding ground.
                    if (shoreGeom) {
                        const shoreFeature = { type: 'Feature', geometry: shoreGeom, properties: {} };
                        const shoreMeshes = polygonFeatureToMeshes(shoreFeature, shoreMat, WATER_Z - 0.2, 0.26 - (WATER_Z - 0.2));
                        shoreMeshes.forEach(m => { markOwnedMaterial(m, shoreMat); m.userData.isLakeShore = true; flatTarget.add(m); });
                    }

                    // Shallow shelf: a solid band from the deep floor up to the shelf level — its
                    // sides close the step down to the open water.
                    if (transitionGeom) {
                        const transitionFeature = { type: 'Feature', geometry: transitionGeom, properties: {} };
                        const transitionMeshes = polygonFeatureToMeshes(transitionFeature, transitionMat, WATER_Z - 0.2, (SHELF_Z - (WATER_Z - 0.2)));
                        transitionMeshes.forEach(m => { markOwnedMaterial(m, transitionMat); flatTarget.add(m); });
                    }

                    // Open water surface, below grade, over a dark lake bed (the water is slightly
                    // transparent, so the bed is what reads as depth).
                    const bedMat = new THREE.MeshLambertMaterial({ color: 0x14324a });
                    const waterFeature = { type: 'Feature', geometry: waterGeom, properties: {} };
                    polygonFeatureToMeshes(waterFeature, bedMat, WATER_Z - 0.2, 0).forEach(m => { markOwnedMaterial(m, bedMat); flatTarget.add(m); });
                    const waterMeshes = polygonFeatureToMeshes(waterFeature, waterMat, WATER_Z, 0);
                    waterMeshes.forEach(m => { markOwnedMaterial(m, waterMat); flatTarget.add(m); });

                    // Render fish as small decorative elements
                    const fishCoords = (graphics && Array.isArray(graphics.fish)) ? graphics.fish : [];
                    fishCoords.forEach(([lng, lat]) => {
                        try {
                            const [x, y] = latLngToXY(lat, lng);
                            // Simple fish: small ellipsoid
                            const fishGeo = new THREE.SphereGeometry(0.15, 8, 8);
                            const fish = new THREE.Mesh(fishGeo, fishMat);
                            markOwnedGeometry(fish, fishGeo);
                            markOwnedMaterial(fish, fishMat);
                            fish.scale.set(1.5, 0.6, 0.4); // Make it fish-shaped
                            fish.position.set(x, y, -1.32); // just above the recessed water surface
                            decoTarget.add(fish);
                        } catch (_) { }
                    });
                };
                placeStructureModel(lake, decoTarget, isCurrentModel, buildBasin);
            } catch (error) {
                console.error('[three-mode] failed to build a lake basin', error);
            }
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
        try { footprints.forEach(fp => { mask = mask ? (T.union(mask, fp) || mask) : fp; }); } catch (error) {
            // The lines pass through unchanged, as documented above.
            reportThreeClip('union', error, 'three-mode.clipTransitLinesOutsideProposals', [mask]);
            mask = null;
        }
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

    // Footprints of the applied corridors that may delete a stretch of this alignment. A road at
    // grade does NOT clip an elevated one — it passes under the deck (TransitAlignments
    // .corridorClipsSource owns that rule and says why); a surface alignment is replaced by
    // anything built over it.
    function clipFootprintsForSource(source) {
        const footprints = [];
        const registry = window.TransitAlignments;
        const clips = registry && typeof registry.corridorClipsSource === 'function'
            ? registry.corridorClipsSource
            : () => true;
        try {
            if (typeof proposalStorage === 'undefined' || typeof collectProposalFeatureSets !== 'function'
                || typeof isApplied !== 'function') return footprints;
            (proposalStorage.getAllProposals() || []).forEach(p => {
                if (!p || !p.roadProposal || !isApplied(p, p.roadProposal)) return;
                const isTrack = typeof corridorIsTrack === 'function'
                    && corridorIsTrack(p.roadProposal.definition);
                if (!clips(source, { isTrack })) return;
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
            // Applied corridors win over an alignment they REPLACE — but not over one they merely
            // pass under, so the clip mask is chosen per source (clipFootprintsForSource).
            for (const source of loadedSources || []) {
                const featureCollection = clipTransitLinesOutsideProposals(
                    source.featureCollection, clipFootprintsForSource(source));
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
            const builtPolicy = buildingDisplayPolicy.resolveBuiltDisplayPolicy(builtDisplay, window.PlanningViews?.getState()?.existingScope);
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

    // Parcel layouts that have NOT been applied to the map. An applied layout has already replaced
    // its parent parcels inside the live fabric, so buildParcels3D draws the new parcels and there
    // is nothing to add here. An unapplied one exists only on the record — without this the 3D view
    // showed the untouched original parcel and the proposed subdivision was invisible.
    function getPlannedParcelLayoutProposals() {
        try {
            const storage = (typeof window !== 'undefined') ? window.proposalStorage : null;
            if (!storage || typeof storage.getAllProposals !== 'function') return [];
            // Ruling 2026-08-07: an unapplied parcel layout renders like any other parked
            // proposal — ONLY while selected, as a preview of where it would land. It used to
            // render persistently, which (after §15d made severance and refusals permanent)
            // kept set-aside plans painted over ground other formations legitimately hold.
            const selectedKey = window.ProposalSelection?.getKey?.() || null;
            if (!selectedKey) return [];
            return storage.getAllProposals().filter(p => {
                if (!p || !p.parcelLayout) return false;
                if (!Array.isArray(p.parcelLayout.plots) || !p.parcelLayout.plots.length) return false;
                if (isApplied(p, p.parcelLayout)) return false;
                return proposalKey3D(p) === String(selectedKey);
            });
        } catch (error) {
            console.warn('[3D] Failed to enumerate planned parcel layouts:', error);
            return [];
        }
    }

    // Draw each planned plot as a flat slab just above the parcel plane, in one neutral tint (a
    // layout carries no owners to colour by), and outline it so the new boundaries read clearly
    // against the parcel underneath.
    function buildPlannedParcelLayout3D(targetGroup) {
        if (!targetGroup) return;
        const proposals = getPlannedParcelLayoutProposals();
        if (!proposals.length) return;

        proposals.forEach(proposal => {
            proposal.parcelLayout.plots.forEach(plot => {
                if (!plot || !plot.geometry) return;
                try {
                    const feature = { type: 'Feature', geometry: plot.geometry, properties: {} };
                    const fillMat = new THREE.MeshLambertMaterial({
                        color: 0xcccccc,
                        transparent: true,
                        opacity: 0.75,
                        polygonOffset: true,
                        polygonOffsetFactor: -2,
                        polygonOffsetUnits: -2
                    });
                    // A set-aside layout's plots can overlap ground OTHER formations hold now
                    // (that overlap is often exactly why it refuses to apply), so the preview
                    // must float clearly above the parcel/road/paving stack (z ≤ ~0.1) —
                    // at 0.08 it sat coplanar with road surfaces and shimmered.
                    const meshes = polygonFeatureToMeshes(feature, fillMat, 0.35, 0);
                    meshes.forEach(m => { markOwnedMaterial(m, fillMat); m.userData.isPlannedLayoutPlot = true; m.renderOrder = 30; targetGroup.add(m); });

                    const borders = polygonFeatureToBorderLines(feature, materials.sliceEdges, 0.45);
                    borders.forEach(line => { line.userData.isPlannedLayoutPlot = true; line.renderOrder = 31; targetGroup.add(line); });
                } catch (error) {
                    console.warn('[3D] Failed to draw a planned parcel-layout plot:', error);
                }
            });
        });
    }

    // Selection drives the preview: clear the previous selection's slabs and draw the current
    // one's (same pattern as rebuildParcelGround3D).
    function rebuildPlannedParcelLayout3D() {
        if (!isActive || !plannedFlatGroup) return;
        for (let index = parcelLayoutGroup.children.length - 1; index >= 0; index--) {
            const child = parcelLayoutGroup.children[index];
            if (child?.userData?.isPlannedLayoutPlot) {
                threeResources.disposeOwnedSubtree(child);
                parcelLayoutGroup.remove(child);
            }
        }
        buildPlannedParcelLayout3D(parcelLayoutGroup);
        applyParcelEmphasis();
    }

    // Recessed lakes and underground station entrances need openings in the otherwise opaque
    // parcel plane. The underground hall itself remains covered; surface/elevated stations do not
    // cut the ground at all.
    function groundCutFootprintFeatures() {
        const lakes = displayedFeatures((typeof window !== 'undefined' && Array.isArray(window.lakes)) ? window.lakes : []);
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
            displayedProposals().forEach(proposal => {
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
                // The parcel ground is drawn without this opening.
                reportThreeClip('difference', error, 'three-mode.cutGroundOpeningsOutOfFeature', [current, cut]);
            }
        }
        return current;
    }

    async function buildParcels3D(targetGroup, generation = parcelGroundGeneration, isCurrent = () => true) {
        const fabric = window.LiveParcelFabric;
        if (!fabric || typeof fabric.queryBounds !== 'function') return;
        const signal = sceneAbort?.signal;
        const stillCurrent = () => isActive && !signal?.aborted && targetGroup === flatGroup
            && generation === parcelGroundGeneration && isCurrent();
        const groundCutFeatures = groundCutFootprintFeatures();
        // parcels at z=0
        await sceneWork.forEach(sceneParcelSnapshot, f => {
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
        }, { isCurrent: stillCurrent });
    }

    async function rebuildParcelGround3D() {
        if (!isActive || !flatGroup) return;
        const targetGroup = flatGroup;
        const signal = sceneAbort?.signal;
        const generation = ++parcelGroundGeneration;
        const stillCurrent = () => isActive && !signal?.aborted && generation === parcelGroundGeneration && targetGroup === flatGroup;
        restoreParcelEmphasis();
        for (let index = targetGroup.children.length - 1; index >= 0; index--) {
            const child = targetGroup.children[index];
            if (child?.userData?.isParcel) { threeResources.disposeOwnedSubtree(child); targetGroup.remove(child); }
        }
        await buildParcels3D(targetGroup, generation, stillCurrent);
        if (!stillCurrent()) return;
        rebuildGroundOnly(null);
        applyParcelVisibilityForMode(derivedParcelVisibilityMode());
        applyParcelEmphasis();
    }

    // Set of parcel IDs that exist *only* because of an applied/executed proposal.
    // Built mode hides them so the 3D view reflects the pre-proposal cadastre.
    // (The corresponding ancestor parcels were removed from the live fabric at apply
    // time; restoring them would need to redraw from each proposal's
    // parentFeatures and is out of scope for this gate — Built mode currently
    // shows holes where proposals replaced the originals.)
    function getAppliedDescendantParcelIdSet() {
        const ids = new Set();
        try {
            const fabric = window.LiveParcelFabric;
            for (const p of getAppliedProposals()) {
                if (!p?.proposalId || !fabric?.producedBy || !fabric?.featureId) continue;
                fabric.producedBy(p.proposalId).forEach(feature => {
                    const id = fabric.featureId(feature);
                    if (id) ids.add(String(id));
                });
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

    // One material per (type, paving): a paved footway gets the same running-bond stone texture the
    // squares are laid with, so the two read as the same material wherever they meet.
    function corridorLaneMaterial(type, paving) {
        const key = paving === 'paved' ? `${type}:paved` : type;
        if (!corridorLaneMaterials[key]) {
            const lane = (typeof CORRIDOR_LANE_TYPES !== 'undefined' && CORRIDOR_LANE_TYPES[type]) || {};
            const surface = (typeof corridorStripSurface === 'function')
                ? corridorStripSurface({ type, paving })
                : (lane.surface || '#2b2b2b');
            const texture = paving === 'paved' ? squareSurfaceMaterials().paving.map : null;
            const material = new THREE.MeshLambertMaterial({
                // White under a texture, or the map's own colours come out muddied by the tint.
                color: texture ? 0xffffff : new THREE.Color(surface),
                map: texture || null,
                emissive: 0x000000
            });
            // A paved material that came out without its texture must not be cached: that would
            // leave the pavement flat-coloured for the rest of the session. Retry next time.
            if (paving === 'paved' && !texture) return material;
            corridorLaneMaterials[key] = material;
        }
        return corridorLaneMaterials[key];
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
    function corridorRibbonMaterial(type, paving) {
        const key = paving === 'paved' ? `${type}:paved` : type;
        if (!corridorRibbonMaterials[key]) {
            const lane = (typeof CORRIDOR_LANE_TYPES !== 'undefined' && CORRIDOR_LANE_TYPES[type]) || {};
            const surface = (typeof corridorStripSurface === 'function')
                ? corridorStripSurface({ type, paving })
                : (lane.surface || '#2b2b2b');
            const texture = paving === 'paved' ? squareSurfaceMaterials().paving.map : null;
            const material = new THREE.MeshLambertMaterial({
                color: texture ? 0xffffff : new THREE.Color(surface),
                map: texture || null,
                emissive: 0x000000,
                side: THREE.DoubleSide
            });
            // Built without its texture it must not be cached — retry rather than stay flat.
            if (paving === 'paved' && !texture) return material;
            corridorRibbonMaterials[key] = material;
        }
        return corridorRibbonMaterials[key];
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
        markOwnedGeometry(mesh, geometry);
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
        if (terrainReference && typeof terrainReference.source === 'string'
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
    // The strips a terrain run draws: a stretch's spans as they are, a transition zone's spans
    // as FUNCTIONS of the fraction along the run (buildRuledStripPositions takes either), sliding
    // from the wide profile's offsets to the narrow one's — the 3D counterpart of the 2D taper.
    function corridorTerrainStripsFor(entry) {
        const taper = entry && entry.taper;
        if (!taper || typeof window.__corridorTransition === 'undefined') return corridorStripSpans(entry.profile);
        const startIsWide = taper.widthStart >= taper.widthEnd;
        const wide = startIsWide ? taper.profileStart : taper.profileEnd;
        const narrow = startIsWide ? taper.profileEnd : taper.profileStart;
        const wideSpans = corridorStripSpans(wide);
        const mapped = window.__corridorTransition.mapSpans(wideSpans, corridorStripSpans(narrow));
        return wideSpans.map((span, index) => {
            const other = mapped[index];
            const from = startIsWide ? span : other;
            const to = startIsWide ? other : span;
            if (Math.abs(from.left - from.right) < 1e-6 && Math.abs(to.left - to.right) < 1e-6) return null;
            return {
                ...span,
                left: s => from.left + (to.left - from.left) * s,
                right: s => from.right + (to.right - from.right) * s
            };
        }).filter(Boolean);
    }

    function addTerrainStrip3D(targetGroup, formationProfile, strip, lane, laneType) {
        const helper = window.__corridorTerrainFormation;
        if (!helper || !formationProfile) return false;
        const kerb = Math.max(0, Number(lane && lane.height) || 0);
        const ruled = helper.buildRuledStripPositions(
            formationProfile,
            typeof strip.left === 'function' ? strip.left : Number(strip.left),
            typeof strip.right === 'function' ? strip.right : Number(strip.right),
            CORRIDOR_STRIP_Z,
            kerb
        );
        if (!ruled || !ruled.ok || !ruled.positions.length) return false;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(ruled.positions, 3));
        // UVs from world XY, matching what ShapeGeometry gives the flat strips. Without them a
        // textured lane — a PAVED footway — samples a single texel and comes out flat-coloured,
        // which is why paving showed in model view and not in photo view.
        const uvs = new Float32Array((ruled.positions.length / 3) * 2);
        for (let i = 0, u = 0; i < ruled.positions.length; i += 3, u += 2) {
            uvs[u] = ruled.positions[i];
            uvs[u + 1] = ruled.positions[i + 1];
        }
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, corridorRibbonMaterial(laneType, strip && strip.paving));
        markOwnedGeometry(mesh, geometry);
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
        return window.BrowserSources.terrainReader(window).url(window);
    }

    function fetchCorridorDguProfile(points) {
        const url = corridorDguTerrainProfileUrl();
        const coordinates = (points || []).map(point => [Number(point.lng), Number(point.lat)]);
        if (coordinates.length < 2 || coordinates.some(pair => !pair.every(Number.isFinite))) {
            return Promise.resolve(null);
        }
        const sourceKey = JSON.stringify(window.BrowserSources.terrainSource(window));
        const cacheKey = sourceKey + '|' + url + '|' + coordinates.map(pair => pair.map(value => value.toFixed(7)).join(',')).join(';');
        if (corridorDguProfileCache.has(cacheKey)) return corridorDguProfileCache.get(cacheKey);
        const request = (async function () {
            let timeout = null;
            let controller = null;
            try {
                if (typeof AbortController === 'function') {
                    controller = new AbortController();
                    timeout = setTimeout(function () { controller.abort(); }, 5000);
                }
                return await window.BrowserSources.terrainReader(window).profile({
                    coordinates, stepM: CORRIDOR_DGU_PROFILE_STEP_M
                }, { fetchImpl: fetch, signal: controller ? controller.signal : undefined, global: window });
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
    function corridorStripPolygon3D(centerline, strip, fallbackPolygon, frame) {
        if (typeof corridorClosedStripPolygonPlanar !== 'function'
            || !Array.isArray(centerline)
            || centerline.length < 4) return fallbackPolygon;
        const first = centerline[0];
        const last = centerline[centerline.length - 1];
        if (!first || !last || Math.abs(first.lat - last.lat) >= 1e-7 || Math.abs(first.lng - last.lng) >= 1e-7) {
            return fallbackPolygon;
        }
        const planar = centerline.map(point => frame.latLngToMetric(point.lat, point.lng));
        const rings = corridorClosedStripPolygonPlanar(planar, strip.left, strip.right);
        if (!rings) return fallbackPolygon;
        return rings.map(ring => ring.map(([x, y]) => {
            const [lat, lng] = frame.metricToLatLng(x, y);
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

        if (kind === 'bike') {
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
            const size = Math.max(1.2, Math.min(3, Number(item.stripWidth) * 0.85));
            const geometry = new THREE.PlaneGeometry(size, size);
            const mesh = new THREE.Mesh(geometry, corridorSymbolMaterial(item.kind));
            markOwnedGeometry(mesh, geometry);
            mesh.position.set(x, y, terrainHeightOrZero(terrainHeightAt, x, y) + CORRIDOR_STRIP_Z + 0.18);
            mesh.rotation.z = Number(item.angle) || 0;
            mesh.userData.isCorridorDecoration = true;
            mesh.userData.decorationKind = item.kind;
            targetGroup.add(mesh);
        });

        if (!treePoints.length) return;
        const species = treeSpeciesApi();
        const looks = treePoints.map(item => {
            const [x, y] = latLngToXY(item.lat, item.lng);
            return { x, y, z: terrainHeightOrZero(terrainHeightAt, x, y) + CORRIDOR_STRIP_Z + 0.15, ...species.treeInstance(item.lng, item.lat) };
        });
        Object.values(speciesTreeMeshes(looks)).forEach(mesh => {
            mesh.userData.isCorridorDecoration = true;
            targetGroup.add(ownInstances(mesh));
        });
    }

    // A junction in 3D (corridor-profile.js junctionTreatmentFor): the carriageway surface as a
    // sheet just above the strips it covers, the footway corners as kerb-high slabs in their own
    // footway's material, then the paint — stop lines and zebras.
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
            (junction.cornerPolygons || []).forEach(corner => {
                const strip = corner.strip || { type: 'sidewalk' };
                const lane = (typeof CORRIDOR_LANE_TYPES !== 'undefined' && CORRIDOR_LANE_TYPES[strip.type]) || {};
                const kerb = Number(lane.height) || 0;
                corridorStripMeshes3D(corridorStripToFeature(corner.polygon), corridorLaneMaterial(strip.type, strip.paving),
                    terrainZ + CORRIDOR_STRIP_Z + 0.161, kerb)
                    .forEach(mesh => {
                        mesh.userData.isCorridorJunction = true;
                        mesh.userData.laneType = strip.type;
                        targetGroup.add(mesh);
                    });
            });
            (junction.stopLinePolygons || []).forEach(polygon => {
                polygonFeatureToMeshes(corridorStripToFeature(polygon), white,
                    terrainZ + CORRIDOR_STRIP_Z + 0.17, 0)
                    .forEach(mesh => {
                        markOwnedMaterial(mesh, white);
                        mesh.userData.isCorridorCrosswalk = true;
                        targetGroup.add(mesh);
                    });
            });
            (junction.crosswalkPolygons || []).forEach(polygon => {
                polygonFeatureToMeshes(corridorStripToFeature(polygon), white,
                    terrainZ + CORRIDOR_STRIP_Z + 0.17, 0)
                    .forEach(mesh => {
                        markOwnedMaterial(mesh, white);
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
    // SAME lines, from the same geometry builders, as flat opaque ribbons just above the surface.
    // They sit above junction asphalt and crosswalk paint: straight-through lane continuity is most
    // useful inside the conflict area, and the old draw order erased it there. Opaque, so they never
    // join the translucent stack that flickers.
    // ---------------------------------------------------------------------------
    const CORRIDOR_MARKING_Z = CORRIDOR_STRIP_Z + 0.19;
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
    // ({ on, off } in metres) is given. Dash phase follows cumulative distance, so the five-metre
    // topology stations used to curve a transition never restart or stretch the paint pattern.
    function addCorridorMarkingPolyline(positions, line, half, dash, terrainHeightAt) {
        if (!Array.isArray(line) || line.length < 2) return;
        const pts = line.map(point => latLngToXY(point.lat, point.lng));
        if (dash) {
            const topology = window.CorridorLaneTopology;
            if (!topology || typeof topology.splitDashedPolyline !== 'function') {
                throw new Error('CorridorLaneTopology.splitDashedPolyline is required for 3D markings');
            }
            topology.splitDashedPolyline(pts, dash).forEach(segment => {
                pushCorridorMarkingQuad(
                    positions,
                    segment[0],
                    segment[1],
                    half,
                    terrainHeightAt
                );
            });
            return;
        }
        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i];
            const b = pts[i + 1];
            pushCorridorMarkingQuad(positions, a, b, half, terrainHeightAt);
        }
    }

    // Every white line of one corridor segment — lane separators (dashed, the solid-flow divide heavier)
    // and parking bays (solid edge + bay dividers) — batched into ONE opaque mesh, so a long road is a
    // single draw call rather than thousands of little ones.
    function addCorridorMarkings3D(targetGroup, entry, terrainHeightAt) {
        try {
        const positions = [];
        const markings = Array.isArray(entry.markings)
            ? entry.markings
            : ((typeof buildCorridorLaneMarkings === 'function')
                ? buildCorridorLaneMarkings([entry.points], entry.profile, entry.frame)
                : []);
        markings.forEach(marking => {
            const isCenterline = marking.kind === 'centerline';
            const half = isCenterline ? 0.09 : 0.075;
            const dash = isCenterline ? { on: 3, off: 2.5 } : { on: 1.5, off: 2.5 };
            (marking.lines || []).forEach(line => addCorridorMarkingPolyline(
                positions, line, half, dash, terrainHeightAt));
        });
        const furniture = { trims: entry.junctionTrims || null };
        // A transition zone paints its lines only (above); bays and arrows follow a constant profile.
        const bays = (!entry.taper && typeof buildCorridorParkingBays === 'function')
            ? buildCorridorParkingBays([entry.points], entry.profile, entry.frame, furniture) : [];
        bays.forEach(bay => addCorridorMarkingPolyline(
            positions, bay.line, bay.kind === 'edge' ? 0.075 : 0.06, null, terrainHeightAt));

        // Direction arrows arrive as convex rings; a fan from vertex 0 triangulates each into the same
        // flat white mesh as the lines.
        const arrows = (!entry.taper && typeof buildCorridorDirectionArrows === 'function')
            ? buildCorridorDirectionArrows([entry.points], entry.profile, entry.frame, furniture) : [];
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
        markOwnedGeometry(mesh, geometry);
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
                markOwnedGeometry(mesh, geometry);
                markOwnedMaterial(mesh, material);
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
                const geometry = new THREE.BoxGeometry(length, 0.12, record.mode === 'overpass' ? 1.1 : 0.8);
                const barrier = new THREE.Mesh(geometry, railMaterial);
                markOwnedGeometry(barrier, geometry);
                markOwnedMaterial(barrier, railMaterial);
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
                const geometry = new THREE.CylinderGeometry(0.32, 0.42, height, 10);
                const pier = new THREE.Mesh(geometry, supportMaterial);
                markOwnedGeometry(pier, geometry);
                markOwnedMaterial(pier, supportMaterial);
                pier.rotation.x = Math.PI / 2;
                pier.position.set(x, y, groundZ + height / 2);
                pier.userData.isGradeSeparationPier = true;
                targetGroup.add(pier);
            });
        }
    }

    function addGradeSeparatedCorridors3D(targetGroup, definition, entries, fallbackProfile, terrainHeightAt) {
        const records = Array.isArray(definition?.gradeSeparations) ? definition.gradeSeparations : [];
        const frame = records.length ? window.__corridorFootprint.frameForDefinition(definition) : null;
        records.forEach(record => {
            if (!record?.from || !record?.crossing || !record?.to
                || (record.mode !== 'underpass' && record.mode !== 'overpass')) return;
            const entry = entries.find(candidate => record.segmentId != null
                && String(candidate.segmentId) === String(record.segmentId));
            const profile = entry?.profile || fallbackProfile;
            if (!profile) return;
            const path = [record.from, record.crossing, record.to];
            buildCorridorStrips([path], profile, frame).forEach(strip => {
                const lane = (typeof CORRIDOR_LANE_TYPES !== 'undefined' && CORRIDOR_LANE_TYPES[strip.type]) || {};
                const kerb = Number(lane.height) || 0;
                (strip.polygons || []).forEach(polygon => {
                    const meshes = corridorStripMeshes3D(
                        corridorStripToFeature(polygon),
                        corridorLaneMaterial(strip.type, strip.paving),
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

    // The point on a polyline closest to (x, y), in scene XY. Used to ask the ROAD what height the
    // pavement beside it should take: the centerline sits inside the road's own terrain support, so
    // it answers where the pavement's own footprint cannot.
    function nearestOnPolylineXY(points, x, y) {
        let best = null;
        let bestDistance = Infinity;
        for (let i = 0; i < points.length - 1; i += 1) {
            const a = points[i];
            const b = points[i + 1];
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const length2 = dx * dx + dy * dy;
            if (length2 < 1e-9) continue;
            const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length2));
            const px = a[0] + dx * t;
            const py = a[1] + dy * t;
            const distance = (x - px) * (x - px) + (y - py) * (y - py);
            if (distance < bestDistance) { bestDistance = distance; best = [px, py]; }
        }
        return best;
    }

    // Insert vertices along a lat/lng ring so no edge is longer than `maxMetres`. Earcut only ever
    // triangulates the vertices it is GIVEN: a long thin pavement described by its corners becomes
    // two enormous triangles, and moving their corners tilts a whole 70 m plane — the same trap
    // addTerrainStrip3D avoids by not using earcut at all.
    function densifyRingLngLat(ring, maxMetres) {
        if (!Array.isArray(ring) || ring.length < 2) return ring;
        const step = Number(maxMetres) > 0 ? Number(maxMetres) : 4;
        const mPerDegLat = 111320;
        const mPerDegLng = 111320 * Math.cos((Number(ring[0][1]) || 0) * Math.PI / 180);
        const out = [ring[0]];
        for (let i = 1; i < ring.length; i += 1) {
            const a = ring[i - 1];
            const b = ring[i];
            const pieces = Math.max(1, Math.ceil(
                Math.hypot((b[0] - a[0]) * mPerDegLng, (b[1] - a[1]) * mPerDegLat) / step));
            for (let k = 1; k < pieces; k += 1) {
                const t = k / pieces;
                out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
            }
            out.push(b);
        }
        return out;
    }

    function densifyPolygonFeature(feature, maxMetres) {
        const geometry = feature && feature.geometry;
        if (!geometry) return feature;
        const rings = list => list.map(ring => densifyRingLngLat(ring, maxMetres));
        if (geometry.type === 'Polygon') {
            return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings(geometry.coordinates) } };
        }
        if (geometry.type === 'MultiPolygon') {
            return { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: geometry.coordinates.map(rings) } };
        }
        return feature;
    }

    // The filled footway of every applied corridor, in 3D and in photo view. The pavement the
    // cross-section editor previews on the 2D map is the same shape here — one derivation, in
    // corridor-edge-fill-scene.js — so the road does not change width when you switch view.
    //
    // Visual only: it never moves the corridor footprint or the takings, which is why it is derived
    // on demand rather than stored. A drag or a cross-section change just produces a new answer on
    // the next build; there is nothing to invalidate.
    function buildCorridorEdgeFills3D(targetGroup, sampleHeight) {
        if (!targetGroup || !window.CorridorEdgeFill || typeof isAppliedCorridorProposal !== 'function') return;
        if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') return;
        const lane = (typeof CORRIDOR_LANE_TYPES !== 'undefined' && CORRIDOR_LANE_TYPES.sidewalk) || {};
        const kerb = Number(lane.height) || 0;

        // A road under construction gets its pavements with the rest of its surface, when built.
        displayedProposals().filter(builtCorridorProposal).forEach(proposal => {
            const definition = corridorProposalDefinition(proposal);
            const centreXY = [];
            try {
                (corridorCenterlineOf(definition) || []).forEach(segment => {
                    (segment || []).forEach(point => centreXY.push(latLngToXY(point.lat, point.lng)));
                });
            } catch (_) { }
            let regions = [];
            try {
                regions = window.CorridorEdgeFill.regionsFor(definition) || [];
            } catch (error) {
                console.warn('[three-mode] edge fill could not be derived', error);
                return;
            }
            const seating = (typeof sampleHeight === 'function' && centreXY.length >= 2);
            regions.forEach(region => {
                try {
                    const material = corridorLaneMaterial(region.type, region.paving);
                    const source = seating ? densifyPolygonFeature(region.geojson, 4) : region.geojson;
                    // Sits a hair under the drawn lane so the two coincide without z-fighting where
                    // they overlap — the fill CONTAINS the drawn width by construction.
                    polygonFeatureToMeshes(source, material, CORRIDOR_STRIP_Z - 0.002, kerb).forEach(mesh => {
                        mesh.userData.isCorridorStrip = true;
                        mesh.userData.isCorridorEdgeFill = true;
                        mesh.userData.laneType = region.type;
                        // The pavement takes the height of THE ROAD BESIDE IT, not of the ground
                        // under itself. A footway is level across its width and follows the road
                        // only along its length; sampling under the pavement asked the wrong
                        // question twice over — the road's terrain support does not reach that far
                        // (most vertices came back empty and the mesh tore into fans), and where it
                        // did answer, the pavement inherited whatever driveway or verge it sat on.
                        if (seating) {
                            try {
                                const position = mesh.geometry.getAttribute('position');
                                for (let i = 0; i < position.count; i += 1) {
                                    const near = nearestOnPolylineXY(centreXY, position.getX(i), position.getY(i));
                                    const h = near ? sampleHeight(near[0], near[1]) : null;
                                    if (Number.isFinite(h)) position.setZ(i, position.getZ(i) + h);
                                }
                                position.needsUpdate = true;
                                mesh.geometry.computeVertexNormals();
                                mesh.geometry.computeBoundingSphere();
                            } catch (_) { }
                        }
                        targetGroup.add(mesh);
                    });
                } catch (error) {
                    console.warn('[three-mode] edge fill mesh failed', error);
                }
            });
        });
    }

    // A road under construction: its pieces cut to the laid share of their total length (in order),
    // the rest drawn at full width as graded earth. Returns the laid pieces to draw as usual.
    function laidCorridorEntries3D(targetGroup, entries, frame, site, proposal) {
        const metric = point => frame.latLngToMetric(point.lat, point.lng);
        const { laid, rest } = buildoutParts().splitRunsAtShare(entries.map(entry => entry.points), buildoutParts().areaShare(site.progress), {
            distance: (a, b) => { const p = metric(a), q = metric(b); return Math.hypot(q[0] - p[0], q[1] - p[1]); },
            lerp: (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t })
        });
        const earth = buildoutProps().materials(THREE).earth;
        rest.forEach((points, index) => {
            if (!points) return;
            buildCorridorStrips([points], entries[index].profile, frame).forEach(strip => strip.polygons.forEach(polygon => {
                corridorStripMeshes3D(corridorStripToFeature(polygon), earth, CORRIDOR_STRIP_Z, 0).forEach(mesh => {
                    mesh.userData.buildoutSite = String(proposal.proposalId);
                    mesh.userData.buildoutPart = 'earth';
                    targetGroup.add(mesh);
                });
            }));
        });
        return entries.map((entry, index) => (laid[index] ? { ...entry, points: laid[index] } : null)).filter(Boolean);
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
            const flatStrips = (entry.taper && typeof buildCorridorPieceStrips === 'function')
                ? buildCorridorPieceStrips({ ...entry, points }, entry.frame)
                : buildCorridorStrips([points], entry.profile, entry.frame);
            flatStrips.forEach(strip => {
                // Rail lanes render as real track in the existing-tram style, not a flat strip.
                if (strip.type === 'rail') { addProposalTrack3D(targetGroup, points, strip); return; }
                const lane = (typeof CORRIDOR_LANE_TYPES !== 'undefined' && CORRIDOR_LANE_TYPES[strip.type]) || {};
                const kerb = Number(lane.height) || 0;
                strip.polygons.forEach(polygon => {
                    const meshPolygon = corridorStripPolygon3D(points, strip, polygon, entry.frame);
                    // A flat OPEN strip whose outline crosses itself (a star, a hairpin) can't be
                    // earcut — the fill floods the whole enclosed area. Lay the same per-edge band.
                    if (kerb === 0 && meshPolygon === polygon && corridorStripRingSelfIntersects(polygon)) {
                        addFlatStripRibbon3D(targetGroup, points, strip.left, strip.right,
                            corridorRibbonMaterial(strip.type, strip.paving), strip.type);
                        return;
                    }
                    corridorStripMeshes3D(
                        corridorStripToFeature(meshPolygon),
                        corridorLaneMaterial(strip.type, strip.paving),
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

        // Every junction once, own and shared alike, from ONE set over every applied corridor —
        // exactly what the 2D map draws (corridor-render.js): the junction's corner geometry, and
        // for each road where its lane lines stop. Grade-separated spans cross in plan but are not
        // junctions, so they are left out of the arms, as in 2D.
        const corridorKeyOf3D = proposal => (proposal && proposal.proposalId != null ? String(proposal.proposalId) : 'proposal');
        const junctionsByCorridor = new Map();
        let junctionSet = [];
        if (typeof buildCorridorJunctionSet === 'function') {
            try {
                // A road under construction joins the junctions when it is built.
                junctionSet = buildCorridorJunctionSet(displayedProposals().filter(builtCorridorProposal).map(proposal => {
                    const definition = corridorProposalDefinition(proposal);
                    const gradeSpans = (typeof gradeSeparationSpanRecords === 'function')
                        ? gradeSeparationSpanRecords(definition.gradeSeparations || []) : [];
                    const entries = [];
                    const frameFor = window.__corridorFootprint.frameForDefinition(definition);
                    const piecesFor = (typeof corridorRenderPieces === 'function')
                        ? corridorRenderPieces(corridorRenderEntriesForDefinition(definition), frameFor, { junctions: definition.junctions })
                        : corridorRenderEntriesForDefinition(definition);
                    piecesFor.forEach(entry => {
                        const runs = gradeSpans.length && typeof corridorSurfaceRuns === 'function'
                            ? corridorSurfaceRuns([entry.points], gradeSpans) : [entry.points];
                        runs.forEach(points => {
                            if (Array.isArray(points) && points.length >= 2) entries.push({ segmentId: entry.segmentId, points, profile: entry.profile });
                        });
                    });
                    return { corridorId: corridorKeyOf3D(proposal), entries };
                }));
            } catch (error) {
                console.error('[three-mode] junction set failed; roads draw without junctions', error);
                junctionSet = [];
            }
            junctionSet.forEach(treatment => (treatment.corridorIds || []).forEach(id => {
                if (!junctionsByCorridor.has(String(id))) junctionsByCorridor.set(String(id), []);
                junctionsByCorridor.get(String(id)).push(treatment);
            }));
        }

        displayedProposals().filter(isAppliedCorridorProposal).forEach(proposal => {
            try {
            const definition = corridorProposalDefinition(proposal);
            const fallbackProfile = corridorProfileOf(definition);
            const centerline = corridorCenterlineOf(definition);
            if (!fallbackProfile || !centerline.length) return;
            const corridorJunctions = junctionsByCorridor.get(corridorKeyOf3D(proposal)) || [];

            // Per-segment cross-sections, same as the 2D renderer: each segment draws with ITS
            // profile (width, lanes, tree groves). Rendering the whole centerline with the
            // default profile flattened every network to one width and dropped override-only
            // lanes (a segment's tree grove never made it into 3D).
            // Everything this corridor draws is measured in its own frame (projections.md §2).
            const frame = window.__corridorFootprint.frameForDefinition(definition);
            // Pieces, as in 2D: a stretch's body plus its transition zones (corridorRenderPieces).
            const pieces = (typeof corridorRenderPieces === 'function')
                ? corridorRenderPieces(corridorRenderEntriesForDefinition(definition), frame, { junctions: definition.junctions })
                : corridorRenderEntriesForDefinition(definition);
            pieces.forEach(entry => { entry.frame = frame; });
            // Under construction, only the laid share of the length is drawn; the rest is earth.
            const site = buildoutSiteOf(proposal.proposalId);
            const renderEntries = site ? laidCorridorEntries3D(targetGroup, pieces, frame, site, proposal) : pieces;
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
                    surfaceRenderEntries.push({
                        ...entry,
                        points,
                        corridorId: proposal && proposal.proposalId != null
                            ? String(proposal.proposalId)
                            : 'proposal'
                    });
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
            const surfaceMarkingsByEntry = (typeof buildCorridorLaneMarkingsForEntries === 'function')
                ? buildCorridorLaneMarkingsForEntries(surfaceRenderEntries, frame, { junctions: corridorJunctions })
                : surfaceRenderEntries.map(surfaceEntry => (
                    buildCorridorLaneMarkings([surfaceEntry.points], surfaceEntry.profile, frame)
                ));

            surfaceRunRecords.forEach((record, recordIndex) => {
                const entry = record.entry;
                const points = record.points;
                const runFormation = record.formation;
                    const runTerrainHeightAt = runFormation
                        ? function (x, y) { return window.__corridorTerrainFormation.heightAt(runFormation, x, y); }
                        : null;
                    if (runFormation && typeof corridorStripSpans === 'function') {
                        corridorTerrainStripsFor(entry).forEach(strip => {
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
                    const decorations = (!entry.taper && typeof buildCorridorDecorations === 'function')
                        ? buildCorridorDecorations([points], entry.profile, frame) : [];
                    addCorridorDecorations3D(targetGroup, decorations, runTerrainHeightAt);
                    addCorridorMarkings3D(targetGroup, {
                        ...entry,
                        points,
                        markings: surfaceMarkingsByEntry[recordIndex] || [],
                        junctionTrims: (typeof corridorEntryJunctionTrims === 'function' && corridorJunctions.length)
                            ? corridorEntryJunctionTrims(points.map(point => frame.latLngToMetric(point.lat, point.lng)), corridorJunctions, frame)
                            : null
                    }, runTerrainHeightAt);

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
            } catch (error) {
                // One corrupt road must not strip the asphalt off EVERY road in 3D (the 2D renderer
                // already isolates per-proposal failures the same way).
                console.error('[three-mode] corridor strips failed for proposal', proposal?.proposalId, error);
            }
        });

        // Junctions once each, over the roads that meet there — the corner geometry covers the
        // seams where different widths meet and where the strips of two roads overlap.
        if (junctionSet.length) {
            const junctionTerrainHeightAt = terrainProfilesOut.length
                ? function (x, y) { return terrainHeightFromProfiles(terrainProfilesOut, x, y); }
                : null;
            try {
                addCorridorJunctions3D(targetGroup, junctionSet, junctionTerrainHeightAt);
            } catch (error) {
                console.error('[three-mode] junctions failed', error);
            }
        }

        // Track surfaces use a different renderer, but building-tunnel metadata is common to both
        // corridor kinds, so liners are added in a second pass over every applied corridor proposal.
        displayedProposals().forEach(proposal => {
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
    function collectAppliedStructureClearanceRegions(proposals = null) {
        const regions = [];
        if (typeof turf === 'undefined' || typeof proposalStorage === 'undefined') return regions;
        try {
            (proposals || displayedProposals()).forEach(proposal => {
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
                try { part = turf.intersect(footprint, region); } catch (error) {
                    // This region does not clear the building in the view.
                    reportThreeClip('intersect', error, 'three-mode.structureClearanceCarve', [footprint, region]);
                    part = null;
                }
                if (!part || (Number(turf.area(part)) || 0) < 2) continue;
                if (!demolishedUnion) demolishedUnion = part;
                else {
                    try { demolishedUnion = turf.union(demolishedUnion, part) || demolishedUnion; } catch (error) {
                        // Only the earlier regions' clearance is drawn.
                        reportThreeClip('union', error, 'three-mode.structureClearanceCarve', [demolishedUnion, part]);
                    }
                }
            }
            if (!demolishedUnion) return null;
            let remainder = null;
            try { remainder = turf.difference(footprint, demolishedUnion); } catch (error) {
                // No remainder: the building is drawn as cleared whole.
                reportThreeClip('difference', error, 'three-mode.structureClearanceCarve', [footprint, demolishedUnion]);
                remainder = null;
            }
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

    const nearbyBuildingGeometryCache = threeResources.createBuildingGeometryCache({
        maxBytes: 64 * 1024 * 1024
    });
    window.__threeModeDisposeBuildingGeometryCache = () => nearbyBuildingGeometryCache.clear();

    async function buildNearbyProposalBuildings3D(targetGroup, buildingMaterial, visibility = {}, isCurrent = () => true) {
        let failures = 0;
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
                displayedProposals(),
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
            const demolishedMaterial = demolishedMaterialFor(buildingMaterial);
            // null → untouched; { remainder: null, demolished } → whole building razed;
            // { remainder, demolished } → partial: prisms for both parts. Both are raw geometries.
            const asFeature = (geometry) => (geometry ? { type: 'Feature', properties: {}, geometry } : null);
            // Structures clear their whole footprint even for meshes the 2D scan never recorded.
            const structureRegions = collectAppliedStructureClearanceRegions();
            const meshDedupeState = nearbyBuildingGeometryCache.beginPass({
                buildings: nearbyProposalBuildings,
                carveRecords,
                structureRegions,
                visibility,
                xrayEnabled,
                suggestedPlansEnabled,
                suggestedExistingEnabled,
                origin: origin3857 ? { x: origin3857.x, y: origin3857.y } : null
            });
            if (Array.isArray(nearbyProposalBuildings) && nearbyProposalBuildings.length > 0) {
                const observed = new Map((window.buildingFeaturePool || []).map(feature =>
                    [String(window.buildingPoolFeatureKey(feature)), feature]));
                await sceneWork.forEach(nearbyProposalBuildings, bld => {
                    try {
                        const inspectionFeature = window.PlanningRepresentations.observedMeshFeature(bld, observed.get(String(bld.object_id)));
                        const addObserved = mesh => {
                            mesh.userData.planningBuiltFeature = inspectionFeature;
                            targetGroup.add(mesh);
                        };
                        const carve = window.carveBuildingByObjectId(bld.object_id, carveRecords)
                            || structureClearanceCarve(bld, structureRegions);
                        const renderParts = buildingDisplayPolicy.resolveBuildingRenderParts(carve, visibility);
                        if (!carve) {
                            if (!renderParts.detailed) return;
                            if (appendBuildingFloorPlans({ type: 'Feature', geometry: bld.floorModel?.footprint, properties: {
                                ...bld.properties, floorPlans: bld.floorPlans || bld.properties?.floorPlans
                            } }, buildingMaterial, building3DHeightMeters(bld), inspectionFeature)) return;
                            const mesh = buildMeshFromBuilding3D(bld, buildingMaterial, meshDedupeState);
                            if (mesh) {
                                addObserved(mesh);
                            }
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
                            // Each prism says which part it is: the Compare tab keeps the remainder
                            // on every side and takes only the condemned part off a side that applies
                            // the demolition.
                            if (renderParts.remainder && remainder) {
                                polygonFeatureToMeshes(remainder, buildingMaterial, 0, height)
                                    .forEach(mesh => { mesh.userData.demolitionPart = 'remainder'; addObserved(mesh); });
                            }
                            if (renderParts.demolished && demolished) {
                                polygonFeatureToMeshes(demolished, demolishedMaterial, 0, height)
                                    .forEach(mesh => { mesh.userData.demolitionPart = 'demolished'; addObserved(mesh); });
                            }
                            return;
                        }
                        if (!renderParts.detailed) return;
                        const mesh = buildMeshFromBuilding3D(bld, demolishedMaterial, meshDedupeState);
                        if (mesh) addObserved(mesh);
                    } catch (e) {
                        failures++;
                        console.warn('Failed to build 3D mesh for building', bld && bld.object_id, e);
                    }
                }, { isCurrent });
            }
        } catch (error) {
            failures++;
            console.warn('Failed to build existing 3D buildings:', error);
        }
        ensureNearbyProposalBuildings();
        return { failures };
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
        const cacheEntry = dedupeState?.geometryCacheSession?.beginEntry(dedupeState) || null;
        if (cacheEntry?.hit) {
            return cacheEntry.geometry ? nearbyBuildingMeshFromGeometry(cacheEntry.geometry, material, false) : null;
        }
        if (!bld || !Array.isArray(bld.faces) || bld.faces.length === 0) {
            cacheEntry?.finish(null);
            return null;
        }
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

        if (positions.length === 0) {
            cacheEntry?.finish(null);
            return null;
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.computeVertexNormals();
        const retainedByCache = cacheEntry ? cacheEntry.finish(geometry) : false;
        return nearbyBuildingMeshFromGeometry(geometry, material, !retainedByCache);
    }

    function nearbyBuildingMeshFromGeometry(geometry, material, ownsGeometry) {
        // Use a two-sided material clone so back faces (from inconsistent winding in source data) still render.
        const mat = cloneBuildingMaterial(material);
        mat.side = THREE.DoubleSide;
        const mesh = new THREE.Mesh(geometry, mat);
        if (ownsGeometry) markOwnedGeometry(mesh, geometry);
        markOwnedMaterial(mesh, mat);
        attachBuildingDepthPrepass(mesh);
        mesh.userData.isNearbyBuilding3D = true;
        // Existing buildings carry no parcelId. Stamp a footprint center (as [lng, lat])
        // so parcel-isolation can later test which parcel this building sits on.
        const positions = geometry.attributes.position.array;
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
    // The last /buildings/near result, keeping empty land distinct from incomplete source evidence.
    let nearbyBuildingsOutcome = null;
    let nearbyBuildingsRevision = 0;
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
            const ids = Array.isArray(props.cadastreParcelIds) && props.cadastreParcelIds.length
                ? props.cadastreParcelIds
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
            entryAnchorGeometry,
            radiusMeters: buildingLoadRadiusM
        });
        sceneLoadGeometry = snapshotNavigation.captureSceneLoadAnchor(selected);
        sceneLoadGeometrySource = proposalGeometry
            ? 'proposal'
            : (selected && selected === appliedWorkGeometry ? 'plan' : 'camera');
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
                (proposal.parcelLayout?.plots || []).forEach(plot => extend(plot?.geometry));
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

    // The last /buildings/near answer's provenance: { source, heights: {measured, levels, estimated}, partial }.
    let nearbyBuildingsProvenance = null;
    let buildingsSourceNoteEl = null;

    function updateBuildingsSourceNote() {
        if (!buildingsSourceNoteEl) return;
        const info = nearbyBuildingsProvenance;
        if (!info || !['osm-3d', 'custom-3d', 'overture-tiles-3d'].includes(info.source)) { buildingsSourceNoteEl.hidden = true; return; }
        const heights = info.heights || { measured: 0, levels: 0, estimated: 0 };
        const total = heights.measured + heights.levels + heights.estimated;
        // A server source is the person's own, or the city's own survey (Bogotá's cadastre).
        const citySource = window.CityConfigManager?.getCurrentCityConfig?.()?.buildings?.source;
        const parts = [info.source === 'overture-tiles-3d'
            ? threeI18n('threeMode.buildingsSource.overture', 'Overture Maps buildings')
            : info.source === 'custom-3d' && citySource === 'cadastre'
                ? threeI18n('sidebar.buildings.showCadastre', 'Cadastre buildings')
                : info.source === 'custom-3d'
                    ? threeI18n('sidebar.buildings.showCustom', 'Your building source')
                    : threeI18n('threeMode.buildingsSource.osm', 'OpenStreetMap buildings')];
        if (heights.estimated > 0) {
            parts.push(threeI18n('threeMode.buildingsSource.estimated', '{{count}} of {{total}} heights estimated',
                { count: heights.estimated, total }).replace('{{count}}', heights.estimated).replace('{{total}}', total));
        }
        if (info.partial) parts.push(threeI18n('threeMode.buildingsSource.partial', 'some may be missing'));
        buildingsSourceNoteEl.textContent = parts.join(' · ');
        buildingsSourceNoteEl.hidden = false;
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

        key = nearbyDataScope + '|' + key;
        if (key === nearbyProposalBuildingsKey) return;

        nearbyProposalBuildingsFetching = true;
        nearbyBuildingsOutcome = null;
        updateBuildingsLoader();
        // The 3D building source is that of the city where the geometry lies: resolved server-side,
        // or read in the browser from Overture's tiles (building-source-client.js).
        const signal = sceneAbort?.signal;
        const current = () => isActive && !signal?.aborted && sceneAbort?.signal === signal;
        window.BuildingSourceClient.request('/buildings/near', { geometry, buffer_meters: buffer }, { signal })
            .then(payload => {
                if (!current()) return;
                const rawBuildings = (payload && Array.isArray(payload.buildings)) ? payload.buildings : [];
                nearbyProposalBuildings = dedupeCoincidentBuildings(rawBuildings);
                nearbyBuildingsRevision++;
                nearbyProposalBuildingsKey = key;
                nearbyProposalBuildingsFetching = false;
                nearbyBuildingsProvenance = payload ? { source: payload.source, heights: payload.heights || null, partial: payload.partial === true } : null;
                nearbyBuildingsOutcome = payload?.supported === false ? 'unsupported'
                    : !payload || payload.unavailable || !Array.isArray(payload.buildings) ? 'failed'
                        : payload.partial === true || payload.truncated === true ? 'partial'
                            : nearbyProposalBuildings.length ? 'loaded' : 'empty';
                updateBuildingsSourceNote();
                // The upstream failed outright: an empty scene must not pass for a city without buildings.
                if (payload && payload.unavailable) reportNearbyBuildingsUnavailable(payload.retryAfter);
                else if (rawBuildings.length) window.clearBuildingsUnavailable?.();
                const dupCount = rawBuildings.length - nearbyProposalBuildings.length;
                console.log(`[3D] Loaded ${nearbyProposalBuildings.length} nearby 3D buildings (${sceneLoadGeometrySource}+${buffer}m${dupCount > 0 ? `, dropped ${dupCount} coincident duplicate${dupCount === 1 ? '' : 's'}` : ''})`);
                if (isActive) rebuild3DBuildingsOnly({ family: 'existing' });
                rebuildProposalGrounds3D();
                refreshLifeSurface();
                updateBuildingsLoader();
                ensureNearbyWater();
                ensureNearbyGreen();
            })
            .catch(err => {
                if (!current() || err.name === 'AbortError') return;
                console.warn('Failed to fetch nearby buildings:', err);
                nearbyProposalBuildingsFetching = false;
                nearbyBuildingsOutcome = 'failed';
                updateBuildingsLoader();
                reportNearbyBuildingsUnavailable(null, err.status);
                ensureNearbyWater();
                ensureNearbyGreen();
            });
    }

    // Said in the building banner (map-core.js), whose Retry asks for this scene's band again.
    function reportNearbyBuildingsUnavailable(retryAfter, status = null) {
        window.reportBuildingsUnavailable?.(retryAfter, () => {
            nearbyProposalBuildingsKey = null;
            ensureNearbyProposalBuildings();
        }, false, status);
    }

    // --- Real-world OSM trees (Overture base/land) ---
    // Toggleable scenery fetched via GET /decor/near for the box of the SAME query geometry + radius as the
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

    // Shared, never disposed: the far tier's blob (unit trunk + unit crown; per-tree size and the
    // species' crown colour come from the instance), the cylinder rotated to run along +Z.
    // The shadow stand-ins' material writes neither colour nor depth: drawn, unseen, still casting
    // (three's shadow pass tests layers against the main camera, so a shadow-only layer cannot do it).
    let treeTrunkGeo = null, treeCrownGeo = null, treeTrunkMat = null, treeCrownMat = null, treeShadowMat = null;
    function ensureTreeAssets() {
        if (treeTrunkGeo) return;
        treeShadowMat = new THREE.MeshLambertMaterial({ colorWrite: false, depthWrite: false });
        treeTrunkGeo = new THREE.CylinderGeometry(0.12, 0.18, 1, 5);
        treeTrunkGeo.rotateX(Math.PI / 2); // Y-length → Z-length (scene is Z-up)
        treeCrownGeo = new THREE.SphereGeometry(1, 6, 5);
        treeTrunkMat = new THREE.MeshLambertMaterial({ color: 0x5c3d1e });
        treeCrownMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    }

    // Two tiers over the loaded trees: those within NEAR_TIER_RADIUS_M of the camera (at most
    // nearTierSize(), nearest first) are species meshes (one InstancedMesh per species, sized for
    // every tree of it), the rest blobs (two InstancedMeshes). Neither casts a shadow: blobs for
    // every tree, drawn invisibly, do: written once, so the shadow pass costs what the blobs always
    // cost. Each tree's look is rolled once per load; when the camera has moved
    // TREE_RETIER_M, renderScene (retierTreesIfMoved) recomputes the near set and rewrites the slots
    // only if it changed. From an orbit high above, nothing is near and nothing is rewritten.
    const TREE_RETIER_M = 25;
    let treeTiers = null; // { looks, points, mask, camera, species: { id: mesh }, trunks, crowns }

    function disposeTreesGroup() {
        treeTiers = null;
        if (!treesGroup) return;
        for (let i = treesGroup.children.length - 1; i >= 0; i--) {
            const c = treesGroup.children[i];
            treesGroup.remove(c);
            if (c.isInstancedMesh) { try { c.dispose(); } catch (_) { } }
            if (c.geometry && c.geometry !== treeTrunkGeo && c.geometry !== treeCrownGeo && !speciesAssets?.shared.has(c.geometry)) c.geometry.dispose();
        }
    }

    // A blob for `look` written into slot `index` of a trunk and a crown mesh; `crownScale` shrinks
    // the shadow stand-ins' crowns inside the species crowns they cast for.
    function setBlobInstance(trunks, crowns, index, look, k, crownScale = 1) {
        const dummy = speciesDummy.object || (speciesDummy.object = new THREE.Object3D());
        const color = speciesDummy.color || (speciesDummy.color = new THREE.Color());
        const blob = treeSpeciesApi().blobOf(look);
        dummy.rotation.set(0, 0, 0);
        dummy.position.set(look.x, look.y, blob.trunkHeight / 2);
        dummy.scale.set(k * look.heightM / 10, k * look.heightM / 10, blob.trunkHeight);
        dummy.updateMatrix();
        trunks.setMatrixAt(index, dummy.matrix);
        dummy.position.set(look.x, look.y, blob.crownZ);
        dummy.scale.set(blob.crownRadius * k * crownScale, blob.crownRadius * k * crownScale, blob.crownHeight * crownScale);
        dummy.updateMatrix();
        crowns.setMatrixAt(index, dummy.matrix);
        crowns.setColorAt(index, color.setRGB(blob.color[0], blob.color[1], blob.color[2], THREE.LinearSRGBColorSpace));
    }

    function buildTreesGroup() {
        if (!treesGroup || !Array.isArray(nearbyTrees) || nearbyTrees.length === 0 || !origin3857) return;
        const visibleTrees = window.__threeSiteGround.contextTreesOutsideCorridors(nearbyTrees,
            displayedProposals(), {
                isAppliedCorridor: isAppliedCorridorProposal, featureSets: collectProposalFeatureSets, turf
            });
        if (!visibleTrees.length) return;
        ensureTreeAssets();
        const api = treeSpeciesApi();
        const looks = [];
        visibleTrees.forEach(t => {
            if (!t || t.length < 2) return;
            const [x, y] = latLngToXY(t[1], t[0]);
            looks.push({ x, y, z: 0, ...api.treeInstance(t[0], t[1]) });
        });
        if (!looks.length) return;
        const assets = ensureSpeciesAssets();
        const capacity = {};
        looks.forEach(look => { capacity[look.species] = (capacity[look.species] || 0) + 1; });
        const species = {};
        Object.keys(capacity).forEach(id => {
            const mesh = new THREE.InstancedMesh(assets.geometries[id], assets.material, capacity[id]);
            mesh.count = 0;
            mesh.userData.treeSpecies = id;
            species[id] = mesh;
        });
        const trunks = new THREE.InstancedMesh(treeTrunkGeo, treeTrunkMat, looks.length);
        const crowns = new THREE.InstancedMesh(treeCrownGeo, treeCrownMat, looks.length);
        [...Object.values(species), trunks, crowns].forEach(mesh => { mesh.userData.noShadowCast = true; });
        const shadowTrunks = new THREE.InstancedMesh(treeTrunkGeo, treeShadowMat, looks.length);
        const shadowCrowns = new THREE.InstancedMesh(treeCrownGeo, treeShadowMat, looks.length);
        const k = lifeMercatorK();
        looks.forEach((look, i) => setBlobInstance(shadowTrunks, shadowCrowns, i, look, k, 0.85));
        [shadowTrunks, shadowCrowns].forEach(mesh => {
            mesh.userData.treeShadowStandIn = true;
            mesh.instanceMatrix.needsUpdate = true;
        });
        treeTiers = { looks, points: looks.map(look => [look.x, look.y]), mask: null, camera: null, species, trunks, crowns };
        retierTrees(treeTierCamera());
        Object.values(species).forEach(mesh => treesGroup.add(mesh));
        treesGroup.add(trunks, crowns, shadowTrunks, shadowCrowns);
    }

    // The camera position the near tier is measured from (scene XY, metric Z).
    function treeTierCamera() {
        return camera ? [camera.position.x, camera.position.y, camera.position.z] : [0, 0, 1e6];
    }

    // Recomputes the near set for a camera position; rewrites the slots and returns true only when it
    // changed.
    function retierTrees(position) {
        const tiers = treeTiers;
        const api = treeSpeciesApi();
        const k = lifeMercatorK();
        const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
        const mask = api.nearTierMask(tiers.points, position[0], position[1], Math.max(0, position[2]) * k,
            api.NEAR_TIER_RADIUS_M * k, api.nearTierSize({ coarsePointer: coarse }));
        tiers.camera = position;
        if (tiers.mask && tiers.mask.every((value, i) => value === mask[i])) return false;
        tiers.mask = mask;
        const filled = {};
        let far = 0;
        tiers.looks.forEach((look, i) => {
            if (!mask[i]) { setBlobInstance(tiers.trunks, tiers.crowns, far++, look, k); return; }
            const slot = filled[look.species] || 0;
            setSpeciesInstance(tiers.species[look.species], slot, look, k);
            filled[look.species] = slot + 1;
        });
        Object.entries(tiers.species).forEach(([id, mesh]) => { mesh.count = filled[id] || 0; });
        tiers.trunks.count = far;
        tiers.crowns.count = far;
        [...Object.values(tiers.species), tiers.trunks, tiers.crowns].forEach(mesh => {
            mesh.instanceMatrix.needsUpdate = true;
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
            mesh.boundingSphere = null;
        });
        return true;
    }

    // Before a render: re-tier once the camera has moved TREE_RETIER_M real metres since the last
    // check. True when the tiers changed (the scene changed).
    function retierTreesIfMoved() {
        if (!treeTiers || !treesGroup?.visible || !camera) return false;
        const position = treeTierCamera();
        const k = lifeMercatorK();
        const last = treeTiers.camera;
        if (last && Math.hypot((position[0] - last[0]) / k, (position[1] - last[1]) / k, position[2] - last[2]) < TREE_RETIER_M) return false;
        return retierTrees(position);
    }

    function rebuildTreesOnly() {
        if (!isActive || !treesGroup) return;
        restoreParcelEmphasis();
        disposeTreesGroup();
        if (treesEnabled) buildTreesGroup();
        applyParcelEmphasis();
        invalidateThreeView();
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
        key = nearbyDataScope + '|' + key;
        if (key === nearbyTreesKey) return;

        nearbyTreesFetching = true;
        const signal = sceneAbort?.signal;
        const current = () => isActive && !signal?.aborted && sceneAbort?.signal === signal;
        fetch(sceneryUrl('/decor/near', geometry, buffer, { kinds: 'trees' }), { signal })
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then(payload => {
                if (!current()) return;
                nearbyTrees = (payload && Array.isArray(payload.trees)) ? payload.trees : [];
                nearbyTreesKey = key;
                nearbyTreesFetching = false;
                console.log(`[3D] Loaded ${nearbyTrees.length} nearby trees (${sceneTreeLoadGeometrySource}+${buffer}m)`);
                if (isActive) rebuildTreesOnly();
            })
            .catch(err => {
                if (!current() || err.name === 'AbortError') return;
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
        invalidateThreeView();
    }

    // --- Life: schematic people and vehicles (three-life.js + life/*.js) ---
    // A toggleable layer of to-scale figures walking sidewalks, footways and plazas, and vehicles
    // driving applied-corridor lanes and existing streets (/osm-road). The pure graph and
    // simulation modules do the work; this section gathers the scene's inputs, owns the toggle and
    // the frame hook, and keeps the render loop on-demand whenever the layer is off. See 3d-life.md.
    const LIFE_STORAGE_KEY = 'cb_3d_life_enabled';
    let lifeOsmFeatures = null;     // /osm-road features for the current snapshot bounds; null until fetched
    let lifeOsmKey = null;
    let lifeOsmFetching = false;
    let lifeQueryBounds = null;
    let lifeAnchorBounds = null;    // where context buildings are loaded: the walkable surface stays inside it
    let lifeFrameHook = null;

    function loadLifeEnabledPref() {
        try {
            if (typeof PersistentStorage !== 'undefined' && PersistentStorage) {
                const v = PersistentStorage.getItem(LIFE_STORAGE_KEY);
                if (v === '0' || v === 'false') return false;
                if (v === '1' || v === 'true') return true;
            }
        } catch (_) { }
        return true; // default ON
    }

    // `?life=0|1` overrides the saved preference (tests, demos); reduced motion keeps the layer off.
    function lifeUrlOverride() {
        try {
            const v = new URLSearchParams(window.location.search || '').get('life');
            if (v === '0' || v === 'off' || v === 'false') return false;
            if (v === '1' || v === 'on' || v === 'true') return true;
        } catch (_) { }
        return null;
    }

    function lifeShouldRun() {
        const override = lifeUrlOverride();
        if (override === false) return false;
        if (window.__reducedMotion && override !== true) return false;
        return override === true || lifeEnabled;
    }

    // Population caps; a phone gets half the crowd.
    function lifeCaps() {
        const small = typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth < 700;
        return small ? { vehicles: 50, people: 32 } : { vehicles: 100, people: 64 };
    }

    // --- Ground: OSM-derived roadbed and pavement (three-ground.js + life/ground-geometry.js) ---
    // The asphalt is laid from the same carriageway list the life graph derives (centreline, lanes
    // and width per street), so the surface the cars drive on is the surface that is drawn, and
    // everything else inside the scene bounds is pavement up to the buildings. Two draw calls, no
    // per-frame work; the layer has its own toggle and `?ground=0|1` override.
    const GROUND_STORAGE_KEY = 'cb_3d_ground_enabled';

    function loadGroundEnabledPref() {
        try {
            if (typeof PersistentStorage !== 'undefined' && PersistentStorage) {
                const v = PersistentStorage.getItem(GROUND_STORAGE_KEY);
                if (v === '0' || v === 'false') return false;
                if (v === '1' || v === 'true') return true;
            }
        } catch (_) { }
        return true; // default ON
    }

    function groundUrlOverride() {
        try {
            const v = new URLSearchParams(window.location.search || '').get('ground');
            if (v === '0' || v === 'off' || v === 'false') return false;
            if (v === '1' || v === 'on' || v === 'true') return true;
        } catch (_) { }
        return null;
    }

    function groundShouldRun() {
        const override = groundUrlOverride();
        return override === null ? groundEnabled : override;
    }

    function ensureGroundLayer() {
        if (groundLayer || !scene || !window.__threeGround) return;
        groundLayer = window.__threeGround.create({ THREE, k: lifeMercatorK() });
        groundLayer.group.visible = false;
        // The parcel slabs are pavement level too: they get the same holes over the sunk roadbed.
        groundLayer.parcelSurface(materials.parcels);
        groundLayer.parcelSurface(materials.roads);
        // A cadastral road parcel outside its asphalt is sidewalk: paved like the pavement plane. Its
        // meshes are in scene units (Mercator-inflated), so the slab grid is scaled back to metres.
        groundLayer.paveTexture(materials.roads, 1 / lifeMercatorK());
        scene.add(groundLayer.group);
    }

    function syncGroundVisibility() {
        if (!groundLayer) return;
        groundLayer.group.visible = groundShouldRun() && !realisticLayerActive && groundLayer.stats().drawCalls > 0;
    }

    // Lay the ground from a life graph; builds its own when the life layer did not (layer off).
    function rebuildGroundOnly(graph) {
        if (!isActive || !scene) return;
        ensureGroundLayer();
        if (!groundLayer) return;
        if (!groundShouldRun() || !window.__groundGeometry) {
            groundLayer.setGeometry(null);
            syncGroundVisibility();
            return;
        }
        try {
            const t0 = performance.now();
            const source = graph || buildLifeGraph();
            // Cover the camera's full rendering reach, not just the fetched street square. The
            // initial far plane is 200 km; orbit zoom can extend it to 10 × distance (plus margin).
            // Only pavement expands: road geometry, population and source requests stay bounded.
            const k = lifeMercatorK();
            const bounds = window.__groundGeometry.pavementBounds(lifeSurfaceBounds(lifeProjector()),
                200000 / k, (camera?.far || 0) / k, (controls?.maxDistance || 0) * 12 / k);
            const result = source ? window.__groundGeometry.buildGroundGeometry({ carriageways: source.surface.carriageways, bounds }) : null;
            const cuts = groundCutFootprintFeatures();
            if (result?.plane && cuts.length) {
                const project = lifeProjector();
                const openings = cuts.map(feature => {
                    const polygon = rings => rings.map(ring => ring.map(([lng, lat]) => project(lng, lat)));
                    return { type: 'Feature', properties: {}, geometry: {
                        type: feature.geometry.type,
                        coordinates: feature.geometry.type === 'Polygon' ? polygon(feature.geometry.coordinates)
                            : feature.geometry.coordinates.map(polygon)
                    } };
                });
                const previousTriangles = result.plane.triangles;
                result.plane = window.__groundGeometry.buildPavementGeometry(bounds, openings, {
                    difference: (surface, opening) => {
                        try { return turf.difference(surface, opening); } catch (error) {
                            reportThreeClip('difference', error, 'three-mode.pavementOpening', [surface, opening]);
                            return surface;
                        }
                    },
                    triangulate: (outer, holes) => THREE.ShapeUtils.triangulateShape(
                        outer.map(([x, y]) => new THREE.Vector2(x, y)),
                        holes.map(ring => ring.map(([x, y]) => new THREE.Vector2(x, y))))
                });
                result.stats.triangles += (result.plane?.triangles || 0) - previousTriangles;
            }
            groundLayer.setGeometry(result);
            if (result) {
                const s = result.stats;
                console.log(`[3D ground] ${s.ways} carriageways, ${s.junctions} junctions, ${s.triangles} triangles, ${s.roadAreaM2} m² asphalt, ${s.kerbM} m kerb (${s.kerbTriangles} triangles), ${s.markingM} m lane lines (${s.markingTriangles} triangles)`
                    + (Array.isArray(lifeOsmFeatures) ? '' : ' (OSM streets pending)') + ` · built in ${(performance.now() - t0).toFixed(0)} ms`);
            }
        } catch (error) {
            console.warn('[3D ground] build failed', error);
            groundLayer.setGeometry(null);
        }
        syncGroundVisibility();
    }

    function setGroundEnabled(on) {
        groundEnabled = !!on;
        try { PersistentStorage.setItem(GROUND_STORAGE_KEY, groundEnabled ? '1' : '0'); } catch (_) { }
        if (groundToggleEl && groundToggleEl.checked !== groundEnabled) groundToggleEl.checked = groundEnabled;
        if (groundEnabled) ensureLifeOsmRoads(lifeQueryBounds);
        rebuildGroundOnly(null);
        invalidateThreeView();
    }

    function disposeGround() {
        if (groundLayer) { try { groundLayer.dispose(); } catch (_) { } }
        groundLayer = null;
    }

    // Scene XY is EPSG:3857 metres, inflated by 1/cos(lat) against true metres while Z stays true.
    function lifeMercatorK() {
        if (!origin3857) return 1;
        const lat = L.CRS.EPSG3857.unproject(L.point(origin3857.x, origin3857.y)).lat;
        return 1 / Math.max(0.1, Math.cos(lat * Math.PI / 180));
    }

    function ensureLifeLayer() {
        if (lifeLayer || !scene || !window.__threeLife) return;
        lifeLayer = window.__threeLife.create({ THREE, k: lifeMercatorK() });
        lifeGroup = lifeLayer.group;
        lifeGroup.visible = false;
        scene.add(lifeGroup);
    }

    // Everything the population moves on, in true metres: applied corridor lanes (with
    // grade-separation heights), existing streets once OSM has answered, and the walkable surface
    // painted from all of it — sidewalk bands, footways, plazas and park lawns are preferred,
    // carriageways are only crossed, and building, structure and water footprints are never entered.
    function lifeProjector() {
        const k = lifeMercatorK();
        return (lng, lat) => { const [x, y] = latLngToXY(lat, lng); return [x / k, y / k]; };
    }

    function lifeSurfaceBounds(project) {
        const b = (Array.isArray(lifeAnchorBounds) && lifeAnchorBounds.length === 4) ? lifeAnchorBounds
            : (Array.isArray(lifeQueryBounds) && lifeQueryBounds.length === 4) ? lifeQueryBounds : null;
        if (!b) return null;
        const corners = [project(b[0], b[1]), project(b[2], b[1]), project(b[2], b[3]), project(b[0], b[3])];
        const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
        const pad = 10;
        return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
    }

    // Footprints people never enter: context buildings, proposed buildings, water, lakes.
    function addLifeBlockedFootprints(builder, project) {
        const features = [];
        (Array.isArray(nearbyProposalBuildings) ? nearbyProposalBuildings : []).forEach(f => features.push(f));
        (Array.isArray(window.proposedBuildings) ? window.proposedBuildings : []).forEach(f => features.push(f));
        (Array.isArray(nearbyWater) ? nearbyWater : []).forEach(piece => { if (piece && piece.geometry) features.push({ type: 'Feature', geometry: piece.geometry }); });
        (Array.isArray(window.lakes) ? window.lakes : []).forEach(f => features.push(f));
        let count = 0;
        features.forEach(feature => { try { builder.addBlockedFeature(feature, project); count++; } catch (_) { } });
        return count;
    }

    function buildLifeSurfaceFrom(graph, project) {
        const api = window.__lifeSurface;
        const bounds = lifeSurfaceBounds(project);
        if (!api || !bounds || !graph) return null;
        return api.buildWalkableSurface({ bounds, ...graph.surface });
    }

    function buildLifeGraph() {
        const api = window.__lifeGraph;
        if (!api || !origin3857) return null;
        const k = lifeMercatorK();
        const project = lifeProjector();
        const builder = api.createGraphBuilder({ drivingSide: window.CityConfigManager.getDrivingSide() });
        if (typeof isAppliedCorridorProposal === 'function' && typeof corridorStripSpans === 'function'
            && typeof proposalStorage !== 'undefined' && typeof proposalStorage.getAllProposals === 'function') {
            proposalStorage.getAllProposals().filter(isAppliedCorridorProposal).forEach(proposal => {
                try {
                    const definition = corridorProposalDefinition(proposal);
                    const entries = corridorRenderEntriesForDefinition(definition);
                    const records = (Array.isArray(definition?.gradeSeparations) ? definition.gradeSeparations : [])
                        .filter(record => record && record.from && record.crossing && record.to);
                    const zAt = records.length
                        ? (x, y) => records.reduce((z, record) => z + gradeElevationAtXY(record, x * k, y * k), 0)
                        : null;
                    const sidewalkKerb = Number(typeof CORRIDOR_LANE_TYPES !== 'undefined' && CORRIDOR_LANE_TYPES.sidewalk && CORRIDOR_LANE_TYPES.sidewalk.height) || 0;
                    builder.addCorridor({
                        id: proposal.proposalId != null ? String(proposal.proposalId) : 'corridor',
                        zLift: CORRIDOR_STRIP_Z, footZLift: CORRIDOR_STRIP_Z + sidewalkKerb, zAt,
                        segments: entries.map(entry => ({
                            id: entry.segmentId,
                            points: entry.points.map(p => project(p.lng, p.lat)),
                            spans: corridorStripSpans(entry.profile)
                        }))
                    });
                } catch (error) { console.warn('[3D life] corridor skipped', error); }
            });
        }
        (Array.isArray(window.parks) ? window.parks : []).forEach(park => {
            try { builder.addPark(park, project); } catch (_) { }
        });
        (Array.isArray(window.squares) ? window.squares : []).forEach(square => {
            try { builder.addSquare(square, project); } catch (_) { }
        });
        if (Array.isArray(lifeOsmFeatures)) builder.addOsmRoads(lifeOsmFeatures, project);
        addLifeBlockedFootprints(builder, project);
        return builder.build();
    }

    // Footprints arrive after the first build (buildings, water): repaint the surface under the
    // existing crowd instead of respawning everyone.
    let lifeSim = null;
    function refreshLifeSurface() {
        if (!lifeSim || !isActive || !scene) return;
        try {
            const t0 = performance.now();
            const graph = buildLifeGraph();
            const surface = buildLifeSurfaceFrom(graph, lifeProjector());
            if (surface) {
                lifeSim.replaceSurface(surface);
                console.log(`[3D life] surface repainted: ${surface.stats.blocked} blocked cells from ${graph.stats.blocked} footprints, `
                    + `${Math.round(surface.stats.preferredAreaM2)} m² preferred, ${lifeSim.people.length} people · ${(performance.now() - t0).toFixed(0)} ms`);
            }
            syncLifeVisibility();
            invalidateThreeView();
        } catch (error) { console.warn('[3D life] surface refresh failed', error); }
    }

    function lifeSeed() {
        if (!origin3857) return 1;
        return ((Math.round(origin3857.x) * 73856093) ^ (Math.round(origin3857.y) * 19349663)) >>> 0;
    }

    function setLifeHook(on) {
        if (on && !lifeFrameHook && lifeLayer) {
            // People and vehicles are decoration: they park after LIFE_IDLE_MS without input (the hook
            // reports nothing to animate, so the loop stops) and walk on at the next touch of the view.
            lifeFrameHook = (now) => {
                if (now - lastInputAt > LIFE_IDLE_MS) return false;
                lifeLayer.onFrame(now);
                return true;
            };
            window.registerThreeModeFrameHook(lifeFrameHook);
        } else if (!on && lifeFrameHook) {
            window.unregisterThreeModeFrameHook(lifeFrameHook);
            lifeFrameHook = null;
        }
    }

    // The hook runs only while a population is both simulated and visible, so an off or hidden
    // layer lets the render loop fall back to on-demand frames.
    function syncLifeVisibility() {
        if (!lifeGroup || !lifeLayer) return;
        const stats = lifeLayer.stats();
        const show = lifeShouldRun() && !realisticLayerActive && (stats.vehicles + stats.people) > 0;
        lifeGroup.visible = show;
        setLifeHook(show);
    }

    function rebuildLifeOnly() {
        if (!isActive || !scene) return;
        ensureLifeLayer();
        let graph = null;
        if (lifeLayer) {
            setLifeHook(false);
            lifeLayer.clear();
            lifeSim = null;
            if (lifeShouldRun() && window.__lifeAgents) {
                const t0 = performance.now();
                graph = buildLifeGraph();
                const surface = buildLifeSurfaceFrom(graph, lifeProjector());
                if (graph && (graph.tracks.length || surface)) {
                    const caps = lifeCaps();
                    lifeSim = window.__lifeAgents.createSimulation(graph, surface, { seed: lifeSeed(), maxVehicles: caps.vehicles, maxPeople: caps.people });
                    lifeLayer.setSimulation(lifeSim);
                    const stats = lifeSim.stats();
                    const s = surface ? surface.stats : null;
                    console.log(`[3D life] ${stats.vehicles} vehicles on ${Math.round(stats.driveLength)} m of lanes, ${stats.people} people on `
                        + (s ? `${Math.round(s.preferredAreaM2)} m² of preferred walking space (grid ${s.cellM} m, ${s.blocked} blocked cells)` : 'no surface')
                        + (Array.isArray(lifeOsmFeatures) ? `, ${lifeOsmFeatures.length} OSM ways` : ', OSM streets pending')
                        + ` · built in ${(performance.now() - t0).toFixed(0)} ms`);
                }
            }
            syncLifeVisibility();
        }
        // The ground shares the graph: the streets the cars drive on are the asphalt it lays.
        rebuildGroundOnly(graph);
        invalidateThreeView();
    }

    // Existing streets and footways for the snapshot bounds, fetched once per bounds; the layer
    // rebuilds with them when they arrive. OSM is the source everywhere: /osm-road answers from
    // the ingested table where a city has rows and otherwise from the backend's Overpass chain
    // (the paid Tracestrack instance, whose key never leaves the server). Only when the backend
    // itself cannot answer does the browser ask a public Overpass instance directly, so the layer
    // still works with our server down; failing that, life runs on proposals and plazas alone.
    // Public Overpass instances, tried in order: the main one answers a 3 km box in 5–40 s under
    // load (measured 2026-10-15), the mirrors cover its outages.
    const LIFE_OVERPASS_URLS = [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://overpass.private.coffee/api/interpreter'
    ];
    const LIFE_OVERPASS_TIMEOUT_S = 60;
    const LIFE_OVERPASS_MAX_SPAN_DEG = 0.03;   // ≈ 3 km; a city-wide entry is clipped around its centre

    function overpassBoundsFor(bounds) {
        let [w, s, e, n] = bounds.map(Number);
        const cx = (w + e) / 2, cy = (s + n) / 2;
        const halfLat = Math.min((n - s) / 2, LIFE_OVERPASS_MAX_SPAN_DEG / 2);
        const halfLng = Math.min((e - w) / 2, LIFE_OVERPASS_MAX_SPAN_DEG / 2 / Math.max(0.2, Math.cos(cy * Math.PI / 180)));
        return [cx - halfLng, cy - halfLat, cx + halfLng, cy + halfLat];
    }

    // Overpass ways → the /osm-road feature shape the graph builder reads.
    function overpassWaysToFeatures(payload) {
        const elements = (payload && Array.isArray(payload.elements)) ? payload.elements : [];
        const features = [];
        elements.forEach(el => {
            if (!el || el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) return;
            const tags = el.tags || {};
            if (!tags.highway) return;
            const width = parseFloat(tags.width);
            features.push({
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: el.geometry.map(p => [p.lon, p.lat]) },
                properties: { osm_id: el.id, highway_type: tags.highway, width_meters: Number.isFinite(width) && width > 0 ? width : null, tags, source: 'overpass' }
            });
        });
        return features;
    }

    function fetchLifeOverpass(bounds) {
        const [w, s, e, n] = overpassBoundsFor(bounds);
        const query = `[out:json][timeout:${LIFE_OVERPASS_TIMEOUT_S}];way[highway](${s},${w},${n},${e});out body geom;`;
        const tryInstance = (index) => {
            if (index >= LIFE_OVERPASS_URLS.length) return Promise.reject(new Error('every Overpass instance failed'));
            const url = LIFE_OVERPASS_URLS[index];
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            const timer = controller ? setTimeout(() => controller.abort(), (LIFE_OVERPASS_TIMEOUT_S + 10) * 1000) : null;
            const t0 = performance.now();
            return fetch(`${url}?data=${encodeURIComponent(query)}`, controller ? { signal: controller.signal } : undefined)
                .then(response => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
                .then(payload => {
                    const features = overpassWaysToFeatures(payload);
                    console.log(`[3D life] Overpass ${new URL(url).host} answered in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
                    return features;
                })
                .catch(error => {
                    console.warn(`[3D life] Overpass ${new URL(url).host} failed (${error && error.message ? error.message : error}); trying the next instance`);
                    return tryInstance(index + 1);
                })
                .finally(() => { if (timer) clearTimeout(timer); });
        };
        return tryInstance(0);
    }

    function ensureLifeOsmRoads(bounds) {
        if (!Array.isArray(bounds) || bounds.length !== 4 || !(lifeShouldRun() || groundShouldRun())) return;
        const key = bounds.map(v => Number(v).toFixed(5)).join(',');
        if (lifeOsmKey === key && (lifeOsmFeatures || lifeOsmFetching)) return;
        lifeOsmKey = key;
        lifeOsmFetching = true;
        lifeOsmFeatures = null;
        const base = (typeof window.getBackendBase === 'function') ? window.getBackendBase() : '';
        const llBounds = L.latLngBounds([[bounds[1], bounds[0]], [bounds[3], bounds[2]]]);
        const query = (typeof wgs84BboxParam === 'function') ? wgs84BboxParam(llBounds)
            : `bbox=${bounds[0]},${bounds[1]},${bounds[2]},${bounds[3]}&crs=EPSG:4326`;
        const settle = (features, source) => {
            if (lifeOsmKey !== key) return;
            lifeOsmFetching = false;
            lifeOsmFeatures = Array.isArray(features) ? features : [];
            console.log(`[3D life] ${lifeOsmFeatures.length} OSM ways from ${source}`);
            if (isActive && scene) rebuildLifeOnly();
        };
        // Our server's answer stands, an empty one included (its own chain already tried public
        // Overpass after Tracestrack); only a server that does not answer sends the browser there.
        fetch(`${base}/osm-road?${query}`)
            .then(response => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
            .then(collection => {
                const features = (collection && Array.isArray(collection.features)) ? collection.features : [];
                settle(features, collection && collection.source === 'overpass' ? 'the backend’s Overpass chain' : 'the ingested osm_road table');
            }, error => {
                console.warn(`[3D life] our server did not answer /osm-road (${error && error.message ? error.message : error}); asking a public Overpass instance`);
                return fetchLifeOverpass(bounds).then(ways => settle(ways, 'a public Overpass instance'));
            })
            .catch(error => {
                if (lifeOsmKey !== key) return;
                lifeOsmFetching = false;
                lifeOsmFeatures = [];
                console.warn('[3D life] existing streets unavailable; life runs on proposals and plazas only', error);
            });
    }

    function setLifeEnabled(on) {
        lifeEnabled = !!on;
        try { PersistentStorage.setItem(LIFE_STORAGE_KEY, lifeEnabled ? '1' : '0'); } catch (_) { }
        if (lifeToggleEl && lifeToggleEl.checked !== lifeEnabled) lifeToggleEl.checked = lifeEnabled;
        if (lifeEnabled) ensureLifeOsmRoads(lifeQueryBounds);
        rebuildLifeOnly();
    }

    function disposeLife() {
        setLifeHook(false);
        if (lifeLayer) { try { lifeLayer.dispose(); } catch (_) { } }
        lifeLayer = null;
        lifeGroup = null;
        lifeSim = null;
    }

    // --- Real-world water (sea, lakes, rivers, streams) ---
    // Fetched via GET /decor/water for the same area and radius as the trees, every piece
    // already a polygon (the backend widens river and stream lines), drawn flat just above the ground
    // in one material. A scene holds a few dozen pieces at most, so it costs next to nothing.
    const WATER_STORAGE_KEY = 'cb_3d_water_enabled';
    let nearbyWater = [];           // [{ geometry, kind }] from the backend
    let nearbyWaterKey = null;
    let nearbyWaterFetching = false;
    let waterEnabled = true;
    let waterMaterial = null;

    function loadWaterEnabledPref() {
        try {
            const v = PersistentStorage.getItem(WATER_STORAGE_KEY);
            if (v === '0') return false;
        } catch (_) { }
        return true; // default ON
    }

    function disposeWaterGroup() {
        if (!waterGroup) return;
        for (let i = waterGroup.children.length - 1; i >= 0; i--) {
            const child = waterGroup.children[i];
            waterGroup.remove(child);
            if (child.geometry) child.geometry.dispose();
        }
    }

    function rebuildWaterOnly() {
        if (!isActive || !waterGroup) return;
        disposeWaterGroup();
        if (!waterEnabled || !nearbyWater.length || !origin3857) return;
        if (!waterMaterial) {
            // Below planned lakes (0.065) and above the parcel slabs; the offset keeps it off the ground.
            waterMaterial = new THREE.MeshPhongMaterial({ color: 0x3b7fc4, specular: 0x1f3a60, shininess: 40,
                polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        }
        for (const piece of nearbyWater) {
            try {
                polygonFeatureToMeshes({ type: 'Feature', geometry: piece.geometry }, waterMaterial, 0.04, 0)
                    .forEach(mesh => { mesh.userData.water = piece.kind; waterGroup.add(mesh); });
            } catch (error) {
                console.warn('[3D] water piece skipped', piece.kind, error);
            }
        }
        invalidateThreeView();
    }

    // The box the loaded buildings cover, [w, s, e, n], or null. Water is cut to it, so it reaches as
    // far as the buildings do whatever the source: the OSM provider answers whole grid cells, well past
    // the radius, and other sources have their own shapes.
    // Every vertex of the loaded band, so it is measured once per response (the array is replaced
    // on each load), not on every building rebuild that asks for scenery.
    let loadedExtentOf = { buildings: null, extent: null };
    function loadedBuildingsExtent() {
        if (loadedExtentOf.buildings !== nearbyProposalBuildings) {
            loadedExtentOf = { buildings: nearbyProposalBuildings, extent: measureBuildingsExtent() };
        }
        return loadedExtentOf.extent;
    }
    function measureBuildingsExtent() {
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const building of nearbyProposalBuildings || []) {
            for (const face of building.faces || []) {
                for (const point of (face.coordinates && face.coordinates[0]) || []) {
                    if (point[0] < w) w = point[0];
                    if (point[0] > e) e = point[0];
                    if (point[1] < s) s = point[1];
                    if (point[1] > n) n = point[1];
                }
            }
        }
        return Number.isFinite(w) && e > w && n > s ? [w, s, e, n] : null;
    }

    // The area tile-based scenery (water, green areas) covers: the loaded buildings' box, or with no
    // buildings (none here, or they failed) the radius around the scene anchor.
    function sceneryQuery() {
        const extent = loadedBuildingsExtent();
        if (extent) {
            const [w, s, e, n] = extent;
            return { queryGeometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }, buffer: 0 };
        }
        return { queryGeometry: sceneTreeLoadGeometry, buffer: buildingLoadRadiusM };
    }

    // A scenery read (GET /decor/near, /decor/water, /decor/green): the query area as its WGS84 box
    // (a point's box is the point) and the buffer around it, so the request is cacheable.
    function sceneryUrl(path, geometry, buffer, extra = {}) {
        const base = (typeof window !== 'undefined' && typeof window.getBackendBase === 'function') ? window.getBackendBase() : '';
        const query = new URLSearchParams({ bbox: turf.bbox(geometry).join(','), buffer_meters: String(buffer), ...extra });
        return `${base}${path}?${query}`;
    }

    function ensureNearbyWater() {
        // Wait for the buildings: their extent is the area to cover.
        if (!waterEnabled || nearbyWaterFetching || nearbyProposalBuildingsFetching) return;
        const { queryGeometry, buffer } = sceneryQuery();
        if (!queryGeometry) return;
        const key = nearbyDataScope + '|' + JSON.stringify(queryGeometry.coordinates) + '|r' + buffer;
        if (key === nearbyWaterKey) return;
        nearbyWaterFetching = true;
        const signal = sceneAbort?.signal;
        const current = () => isActive && !signal?.aborted && sceneAbort?.signal === signal;
        fetch(sceneryUrl('/decor/water', queryGeometry, buffer), { signal })
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then(payload => {
                if (!current()) return;
                nearbyWater = (payload && Array.isArray(payload.areas)) ? payload.areas : [];
                nearbyWaterKey = key;
                nearbyWaterFetching = false;
                console.log(`[3D] Loaded ${nearbyWater.length} nearby water pieces (${sceneTreeLoadGeometrySource}+${buffer}m)`);
                rebuildWaterOnly();
                refreshLifeSurface();
            })
            .catch(err => {
                if (!current() || err.name === 'AbortError') return;
                // Scenery: the scene stands without it, so this is a log line, not a banner.
                console.warn('Failed to fetch nearby water:', err);
                nearbyWaterFetching = false;
            });
    }

    function setWaterEnabled(on) {
        waterEnabled = !!on;
        try { PersistentStorage.setItem(WATER_STORAGE_KEY, waterEnabled ? '1' : '0'); } catch (_) { }
        if (waterGroup) waterGroup.visible = waterEnabled && !realisticLayerActive;
        if (waterEnabled) {
            ensureNearbyWater();
            rebuildWaterOnly();
        }
        invalidateThreeView();
    }

    // --- Real-world green areas (lawns and parks, meadows and farmland, woods) ---
    // Fetched via GET /decor/green for the same area as the water (OpenFreeMap landcover, every city)
    // and merged into one mesh per look with the grass pattern (three-grass.js): three draw calls
    // however many pieces. Just above the parcel slabs (0), below water (0.04), corridor strips (0.05)
    // and planned parks and squares (0.06), which all cover it.
    const GREEN_STORAGE_KEY = 'cb_3d_green_enabled';
    const GREEN_Z = 0.03;
    const GREEN_VARIANT = { lawn: 'lawn', meadow: 'wild', forest: 'forest' }; // look → grass pattern
    // Green is layered over the parcels by stencil claims, not by its 3 cm lift (three-ground.js
    // ORDER): a phone's depth buffer striped it through them. Where two looks overlap, the more
    // specific one wins: a garden over a meadow, a clearing's meadow over the wood around it.
    const GREEN_ORDER = { lawn: -7, meadow: -6, forest: -5 };
    let nearbyGreen = [];           // [{ geometry, kind }] from the backend
    let nearbyGreenKey = null;
    let nearbyGreenFetching = false;
    let greenEnabled = true;

    function loadGreenEnabledPref() {
        try {
            if (PersistentStorage.getItem(GREEN_STORAGE_KEY) === '0') return false;
        } catch (_) { }
        return true; // default ON
    }

    function disposeGreenGroup() {
        if (!greenGroup) return;
        for (let i = greenGroup.children.length - 1; i >= 0; i--) {
            const child = greenGroup.children[i];
            greenGroup.remove(child);
            child.geometry?.dispose();
            child.material?.dispose();
        }
    }

    // Every polygon of `pieces` triangulated flat at `z`, as one indexed geometry.
    function mergedFlatGeometry(pieces, z) {
        const parts = [];
        for (const piece of pieces) {
            const polygons = piece.geometry.type === 'Polygon' ? [piece.geometry.coordinates] : piece.geometry.coordinates;
            for (const rings of polygons) {
                const shape = arrayOfLngLatRingsToShape(rings);
                if (shape) parts.push(new THREE.ShapeGeometry(shape));
            }
        }
        let vertices = 0, indices = 0;
        parts.forEach(part => { vertices += part.attributes.position.count; indices += part.index.count; });
        const position = new Float32Array(vertices * 3);
        const index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
        let v = 0, i = 0;
        parts.forEach(part => {
            const source = part.attributes.position.array;
            for (let k = 0; k < source.length; k += 3) position.set([source[k], source[k + 1], z], (v * 3) + k);
            const partIndex = part.index.array;
            for (let k = 0; k < partIndex.length; k++) index[i++] = partIndex[k] + v;
            v += part.attributes.position.count;
            part.dispose();
        });
        const normal = new Float32Array(vertices * 3);
        for (let k = 2; k < normal.length; k += 3) normal[k] = 1;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
        geometry.setIndex(new THREE.BufferAttribute(index, 1));
        geometry.computeBoundingSphere();
        return geometry;
    }

    function rebuildGreenOnly() {
        if (!isActive || !greenGroup) return;
        disposeGreenGroup();
        if (!greenEnabled || !nearbyGreen.length || !origin3857) return;
        const grass = window.__threeGrass;
        ensureGroundLayer();
        for (const [kind, variant] of Object.entries(GREEN_VARIANT)) {
            const pieces = nearbyGreen.filter(piece => piece.kind === kind);
            if (!pieces.length) continue;
            try {
                const material = grass.grassTexture(new THREE.MeshLambertMaterial({ color: grass.COLORS[variant],
                    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), 1 / lifeMercatorK(), variant);
                groundLayer.parcelSurface(material);
                const mesh = new THREE.Mesh(mergedFlatGeometry(pieces, GREEN_Z), material);
                mesh.renderOrder = GREEN_ORDER[kind];
                mesh.userData.green = kind;
                greenGroup.add(mesh);
            } catch (error) {
                console.warn('[3D] green areas skipped', kind, error);
            }
        }
        invalidateThreeView();
    }

    function ensureNearbyGreen() {
        // Wait for the buildings, like the water: their extent is the area to cover.
        if (!greenEnabled || nearbyGreenFetching || nearbyProposalBuildingsFetching) return;
        const { queryGeometry, buffer } = sceneryQuery();
        if (!queryGeometry) return;
        const key = nearbyDataScope + '|' + JSON.stringify(queryGeometry.coordinates) + '|r' + buffer;
        if (key === nearbyGreenKey) return;
        nearbyGreenFetching = true;
        const signal = sceneAbort?.signal;
        const current = () => isActive && !signal?.aborted && sceneAbort?.signal === signal;
        fetch(sceneryUrl('/decor/green', queryGeometry, buffer), { signal })
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then(payload => {
                if (!current()) return;
                nearbyGreen = (payload && Array.isArray(payload.areas)) ? payload.areas : [];
                nearbyGreenKey = key;
                nearbyGreenFetching = false;
                console.log(`[3D] Loaded ${nearbyGreen.length} nearby green areas (${sceneTreeLoadGeometrySource}+${buffer}m)`);
                rebuildGreenOnly();
            })
            .catch(err => {
                if (!current() || err.name === 'AbortError') return;
                // Scenery: the scene stands without it, so this is a log line, not a banner.
                console.warn('Failed to fetch nearby green areas:', err);
                nearbyGreenFetching = false;
            });
    }

    function setGreenEnabled(on) {
        greenEnabled = !!on;
        try { PersistentStorage.setItem(GREEN_STORAGE_KEY, greenEnabled ? '1' : '0'); } catch (_) { }
        if (greenGroup) greenGroup.visible = greenEnabled && !realisticLayerActive;
        if (greenEnabled) {
            ensureNearbyGreen();
            rebuildGreenOnly();
        }
        invalidateThreeView();
    }

    // Registry of renderable scenery layers: maps an osm_decor `kind` to its panel label and
    // enable/disable hooks. The 3D panel renders a checkbox per layer that BOTH appears here AND is
    // reported available by GET /decor/layers for the current city. Add a layer's renderer + an entry
    // here and it shows up automatically wherever it's been ingested.
    const DECOR_LAYERS = {
        trees: { label: 'Trees', isEnabled: () => treesEnabled, setEnabled: (on) => setTreesEnabled(on) },
        water: { label: 'Water', isEnabled: () => waterEnabled, setEnabled: (on) => setWaterEnabled(on) },
        green: { label: 'Green areas', isEnabled: () => greenEnabled, setEnabled: (on) => setGreenEnabled(on) }
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
            label.title = threeI18n('threeMode.controls.' + key + 'Tooltip', spec.label);
            label.setAttribute('aria-label', label.title);
            label.appendChild(cb);
            label.appendChild(text);
            row.appendChild(label);
            decorTogglesEl.appendChild(row);
        }
    }

    // Ask the backend which scenery layers the area in view has, then render toggles for them. Called
    // on entering 3D; an area with no scenery gets no scenery toggles (water is everywhere).
    function refreshDecorToggles() {
        if (!decorTogglesEl) return;
        let bounds = null;
        try { bounds = window.map && window.map.getBounds(); } catch (_) { bounds = null; }
        if (!bounds) { decorTogglesEl.innerHTML = ''; return; }
        const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].map(v => v.toFixed(5)).join(',');
        const base = (typeof window !== 'undefined' && typeof window.getBackendBase === 'function') ? window.getBackendBase() : '';
        fetch(`${base}/decor/layers?bbox=${bbox}`)
            .then(r => (r.ok ? r.json() : { layers: [] }))
            .then(payload => renderDecorToggles((payload && Array.isArray(payload.layers)) ? payload.layers : []))
            .catch(() => { /* leave whatever's there; toggles are non-critical */ });
    }

    // ---- Build-out over time (buildout-clock.js, docs/buildout-timeline.md) ----
    // Display only. A design not started at the clock's month is left out as if it were not applied,
    // so the context it demolishes or clears still stands; one under construction draws its site
    // (buildout-parts.js decides which parts). Nothing is unapplied. Empty while the clock is closed,
    // which leaves the scene exactly the normal one.
    let buildoutSites = new Map(); // proposalId → { phase, progress, key } of the designs not built
    const buildoutParts = () => window.BuildoutParts;
    const buildoutProps = () => window.__threeBuildout;
    function buildoutSiteOf(id) { return id == null ? null : buildoutSites.get(String(id)) || null; }
    // One building's state: a building of a simulated urban rule has its own (buildout-clock.js
    // unbuilt().buildings, by the feature's buildingIndex); any other follows its design.
    function buildoutBuildingState(feature, site) {
        const index = Number(feature?.properties?.buildingIndex);
        return (Number.isInteger(index) && site.buildings?.[index]) || site;
    }
    function buildoutPlanned(proposal) { return buildoutSiteOf(proposal?.proposalId)?.phase === 'planned'; }
    function displayedProposals() {
        const all = (typeof proposalStorage !== 'undefined' && proposalStorage.getAllProposals()) || [];
        return buildoutSites.size ? all.filter(proposal => !buildoutPlanned(proposal)) : all;
    }
    function displayedFeatures(features) {
        return buildoutSites.size ? features.filter(feature => buildoutSiteOf(feature?.properties?.proposalId)?.phase !== 'planned') : features;
    }
    const builtCorridorProposal = proposal => isAppliedCorridorProposal(proposal) && !buildoutSiteOf(proposal?.proposalId);
    function buildoutFloorHeight(feature) {
        const rule = feature?.properties?.urbanRule?.floorHeightM;
        return typeof rule === 'number' && Number.isFinite(rule) && rule > 0 ? rule : (window.STOREY_HEIGHT_M || 3.3);
    }
    const buildoutStoreys = feature => buildoutParts().storeys(estimateBuildingHeightMeters(feature), buildoutFloorHeight(feature));

    function computeBuildoutSites() {
        const sites = new Map();
        const unbuilt = window.BuildoutClock?.unbuilt?.();
        if (!unbuilt?.size) return sites;
        const buildings = new Map();
        (Array.isArray(window.proposedBuildings) ? window.proposedBuildings : []).forEach(feature => {
            const id = String(feature?.properties?.proposalId);
            if (!unbuilt.has(id)) return;
            if (!buildings.has(id)) buildings.set(id, []);
            buildings.get(id).push({ floors: buildoutStoreys(feature), state: buildoutBuildingState(feature, unbuilt.get(id)) });
        });
        const grounds = new Set(['parks', 'squares', 'lakes'].flatMap(key => (Array.isArray(window[key]) ? window[key] : [])
            .map(feature => String(feature?.properties?.proposalId))));
        unbuilt.forEach((state, id) => {
            const area = grounds.has(id) || isAppliedCorridorProposal(state.proposal) || !buildings.has(id);
            sites.set(id, { phase: state.phase, progress: state.progress, buildings: state.buildings || null,
                key: buildoutParts().siteKey(state, { buildings: buildings.get(id) || [], area }) });
        });
        return sites;
    }

    // Which existing buildings the displayed designs demolish or clear: the existing family is redrawn
    // only when a design's start month changes this.
    function buildoutDemolitionSignature() {
        const { records } = window.collectCarveRecords(displayedProposals());
        return JSON.stringify([[...records.keys()].sort(), collectAppliedStructureClearanceRegions().length]);
    }

    function rebuildCorridors3D() {
        if (!corridorGroup) return;
        clearGroupChildren(corridorGroup);
        try { buildCorridorStrips3D(corridorGroup); } catch (error) { console.warn('[three-mode] corridor strips failed', error); }
        try { buildCorridorEdgeFills3D(corridorGroup); } catch (error) { console.warn('[three-mode] corridor edge fills failed', error); }
        if (corridorTerrainSampler) rebuildTerrainCorridorGroup(corridorTerrainSampler, corridorTerrainReferences);
    }

    // The clock moved: redraw only the layers of the designs whose site changed (a phase, a built
    // floor, a tenth of a road or ground), never on a month that changes nothing.
    function refreshBuildout3D() {
        const started = performance.now();
        const before = buildoutSites;
        const next = computeBuildoutSites();
        const diff = buildoutParts().diffSites(before, next);
        if (!diff.changed.size) { buildoutSites = next; return; }
        if (!isActive || !scene) {
            // A warm scene must not come back with yesterday's sites; initScene recomputes them.
            buildoutSites = next;
            sceneRevision++;
            return;
        }
        // A scene still being built draws the sites it started with; bring it up to date after.
        if (!sceneReady) { sceneReadyPromise?.then(refreshBuildout3D); return; }
        const layers = [];
        const timed = (name, run) => { const t0 = performance.now(); const result = run(); layers.push(`${name} ${Math.round(performance.now() - t0)} ms`); return result; };
        const demolitionChanged = timed('demolition check', () => {
            if (!diff.plannedChanged) { buildoutSites = next; return false; }
            const before = buildoutDemolitionSignature();
            buildoutSites = next;
            return buildoutDemolitionSignature() !== before;
        });
        const ofKind = list => (Array.isArray(list) ? list : []).some(feature => diff.changed.has(String(feature?.properties?.proposalId)));
        const proposals = proposalStorage.getAllProposals();
        const changedProposals = proposals.filter(proposal => diff.changed.has(String(proposal.proposalId)));
        const corridors = changedProposals.some(proposal => isAppliedCorridorProposal(proposal));
        const buildings = ofKind(window.proposedBuildings);
        // A design's open ground is earth while it is built, so only a phase change of a design with
        // a ground redraws the designs' grounds. The vacant plots keep their normal state: redrawing
        // them re-carves every existing building (~100 ms).
        const grounds = (diff.plannedChanged || diff.unbuiltChanged)
            && (window.BuildingGround?.appliedSurfaces(changedProposals, isApplied) || []).length > 0;
        if (buildings || demolitionChanged) {
            const family = buildings && demolitionChanged ? 'all' : buildings ? 'planned' : 'existing';
            timed(`${family} buildings (queued)`, () => rebuild3DBuildingsOnly({ family }));
        }
        if (corridors) timed('corridors', rebuildCorridors3D);
        if (corridors && diff.plannedChanged) timed('trees', rebuildTreesOnly);
        const structures = [['parks', parkGroundGroup, parkGroup, () => buildParks3D(parkGroundGroup, parkGroup)],
            ['squares', squareGroundGroup, squareGroup, () => buildSquares3D(squareGroundGroup, squareGroup)],
            ['lakes', lakeGroundGroup, lakeGroup, () => buildLakes3D(lakeGroundGroup, lakeGroup)]];
        structures.forEach(([key, ground, deco, build]) => {
            if (!ofKind(window[key])) return;
            timed(key, () => {
                clearGroupChildren(ground);
                clearGroupChildren(deco);
                try { build(); } catch (error) { console.error(`[three-mode] build-out ${key} failed`, error); }
                if (key === 'lakes' && diff.plannedChanged) rebuildParcelGround3D();
            });
        });
        if (grounds) timed('grounds', rebuildDesignGrounds3D);
        applyModeVisibility();
        invalidateThreeView();
        console.log(`[${new Date().toISOString()}] [3D build-out] ${window.BuildoutClock?.month() || 'now'}: ${diff.changed.size} design(s) changed in ${Math.round(performance.now() - started)} ms: ${layers.join(', ')}`);
    }
    window.addEventListener('buildoutchange', refreshBuildout3D);

    // Ground not finished: graded earth with the share laid so far in its cover material.
    // `ownCover`: the cover material belongs to this build (disposed with it), as in the caller.
    function addBuildoutGround3D(target, feature, coverMaterial, site, { z = 0.06, ownCover = false } = {}) {
        const id = String(feature.properties?.proposalId);
        const { covered, bare } = buildoutParts().groundShares(feature.geometry, buildoutParts().areaShare(site.progress));
        const add = (geometry, material, part) => {
            if (!geometry) return;
            polygonFeatureToMeshes({ type: 'Feature', properties: {}, geometry }, material, z, 0).forEach(mesh => {
                if (part === 'cover' && ownCover) markOwnedMaterial(mesh, material);
                mesh.userData.buildoutSite = id;
                mesh.userData.buildoutPart = part;
                target.add(mesh);
            });
        };
        add(bare, buildoutProps().materials(THREE).earth, 'earth');
        add(covered, coverMaterial, 'cover');
    }

    // A building under construction: its built floors with the top one in scaffold, or the
    // excavation pit while none stand. Registers the site's crane in `cranes`: one per design, or
    // one per building when the building has its own state (`ownSite`, a simulated urban rule).
    function addBuildoutBuilding3D(feat, site, material, targetGroup, variationDeps, cranes, ownSite = false) {
        const id = String(feat.properties?.proposalId);
        const craneKey = ownSite ? `${id}:${feat.properties?.buildingIndex}` : id;
        const plan = window.UrbanRuleVariation.plannedDrawPlan(feat, plannedRepresentation, variationDeps, buildOutDisplaySalt);
        const drawn = plan.buildOut || plan.massing || feat;
        const parts = buildoutParts().buildingSite(buildoutStoreys(feat), site);
        if (!parts) return;
        const floorHeight = buildoutFloorHeight(drawn);
        const fullHeight = estimateBuildingHeightMeters(drawn);
        const builtHeight = Math.min(fullHeight, parts.floors * floorHeight);
        const group = new THREE.Group();
        group.userData.buildingFamily = 'planned';
        group.userData.buildoutSite = id;
        group.userData.buildoutFloors = parts.floors;
        const props = buildoutProps().materials(THREE);
        const flat = (geometry, mat, z, depth, part) => polygonFeatureToMeshes({ type: 'Feature', properties: {}, geometry }, mat, z, depth)
            .forEach(mesh => { mesh.userData.buildoutPart = part; mesh.userData.proposalId = id; group.add(mesh); });
        if (parts.pit) {
            try { flat(turf.buffer(drawn, 2, { units: 'meters' }).geometry, props.earth, 0.065, 0, 'earth'); } catch (_) { /* the pit alone */ }
            flat(drawn.geometry, props.pit, 0.07, 0, 'pit');
        } else {
            createBuildingSlices(drawn, builtHeight, material, group, feat, null);
        }
        if (parts.scaffold) {
            try {
                flat(turf.buffer(drawn, 0.8, { units: 'meters' }).geometry, props.scaffold,
                    Math.max(0, builtHeight - floorHeight), floorHeight + 1.2, 'scaffold');
            } catch (error) { console.warn('[3D build-out] scaffold skipped', id, error); }
        }
        targetGroup.add(group);
        if (!parts.crane) return;
        let area = 0;
        try { area = turf.area(drawn); } catch (_) { area = 0; }
        if (cranes.has(craneKey) && cranes.get(craneKey).area >= area) return;
        const [lng, lat] = turf.pointOnFeature(drawn).geometry.coordinates;
        const [x, y] = latLngToXY(lat, lng);
        const k = lifeMercatorK();
        let reach = 0;
        turf.coordAll(drawn).forEach(([vx, vy]) => {
            const [px, py] = coordsToXY([vx, vy]);
            reach = Math.max(reach, Math.hypot(px - x, py - y) / k);
        });
        let hash = 0;
        for (const char of craneKey) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
        cranes.set(craneKey, { area, x, y, heightM: fullHeight + 8, jibM: Math.max(18, reach + 6), angle: (hash % 360) * Math.PI / 180 });
    }

    async function buildProposedBuildings3D(targetGroup, buildingMaterial, isCurrent = () => true) {
        const arr = displayedFeatures((typeof window !== 'undefined' && Array.isArray(window.proposedBuildings)) ? window.proposedBuildings : []);
        if (!arr || arr.length === 0) return;
        const variationDeps = { turf };
        const cranes = new Map();
        // Buildings of one design that share a wall: their party walls get no balconies or
        // windows, and do not decide which way a roof's ridge runs.
        const byProposal = new Map();
        arr.forEach(f => {
            const id = f?.properties?.proposalId;
            if (id == null || !f.geometry) return;
            if (!byProposal.has(id)) byProposal.set(id, []);
            byProposal.get(id).push(f);
        });
        const ruleDetails = (drawn, height, feat) => {
            if (!drawn?.properties?.urbanRule) return null;
            try {
                return ruleRoofs.planFor(drawn, height, (byProposal.get(feat.properties?.proposalId) || []).filter(f => f !== feat));
            } catch (error) {
                console.warn(`[${new Date().toISOString()}] [3D] Roof and balconies skipped`, feat.properties?.proposalId, error);
                return null;
            }
        };
        await sceneWork.forEach(arr, feat => {
            if (!feat || !feat.geometry) return;
            const site = buildoutSiteOf(feat.properties?.proposalId);
            const state = site ? buildoutBuildingState(feat, site) : null;
            if (state && state.phase !== 'built') {
                try { addBuildoutBuilding3D(feat, state, buildingMaterial, targetGroup, variationDeps, cranes, state !== site); } catch (error) {
                    console.error(`[${new Date().toISOString()}] [3D build-out] site of design ${feat.properties?.proposalId} failed`, error);
                }
                return;
            }
            // The architectural model owns this building's surfaces in Xray mode.
            // Its old solid proxy would otherwise hide the rooms in the depth buffer.
            if (appendBuildingFloorPlans(feat, buildingMaterial, estimateBuildingHeightMeters(feat))) return;
            // Without evidence, X-ray can still show a generated default layout per parcel slice.
            if (appendSuggestedFloorPlans(feat, buildingMaterial, targetGroup, variationDeps)) return;
            try {
                // Uploaded buildings carry a glTF model URL — render the real mesh instead of an extruded box.
                if (feat.properties && feat.properties.modelUrl) {
                    placeUploadedModel(feat, targetGroup, buildingMaterial);
                    return;
                }
                // Massing, example build-out, or the example inside its envelope — the choice
                // itself lives in urban-rule-variation.js, where it is unit-tested.
                const plan = window.UrbanRuleVariation.plannedDrawPlan(
                    feat, plannedRepresentation, variationDeps, buildOutDisplaySalt);
                if (plan.buildOut) {
                    const height = estimateBuildingHeightMeters(plan.buildOut);
                    createBuildingSlices(plan.buildOut, height, buildingMaterial, targetGroup, feat, ruleDetails(plan.buildOut, height, feat));
                }
                if (plan.massing) {
                    const envelope = plan.massingStyle === 'envelope';
                    const height = estimateBuildingHeightMeters(plan.massing);
                    createBuildingSlices(plan.massing, height, envelope ? buildingMaterials.massing : buildingMaterial, targetGroup,
                        envelope ? null : feat, envelope ? null : ruleDetails(plan.massing, height, feat));
                }
            } catch (_) { }
        }, { isCurrent });
        if (!cranes.size || !isCurrent()) return;
        // Every crane of the scene: one shared instanced model.
        const craneGroup = new THREE.Group();
        craneGroup.name = 'BuildoutCranes';
        buildoutProps().cranes(THREE, [...cranes.values()], lifeMercatorK()).forEach(mesh => craneGroup.add(mesh));
        targetGroup.add(craneGroup);
    }

    // Plots an applied urban rule LEFT OUT, drawn as the volume each would carry.
    //
    // A block excludes a plot when it is under the minimum plot size, when only a splinter of the
    // block falls on it, or when the massing never reaches it. Those plots are still part of the
    // block — merge one with a neighbour or buy it and this is the building it takes — so they are
    // shown as see-through volumes rather than as an unexplained gap in the street. Off by default:
    // this answers "why is there nothing here", it is not part of the plan.
    function buildIneligibleParcels3D(targetGroup) {
        // Same collector the 2D layer draws from (building-blocks.js), so the two views can never
        // disagree about which plots the rule left out.
        const parts = (typeof window !== 'undefined' && typeof window.appliedIneligibleBlockParts === 'function')
            ? window.appliedIneligibleBlockParts()
            : [];
        parts.forEach(feature => {
            if (!feature || !feature.geometry) return;
            // Only the would-be BUILDING is raised. The plot outline is a 2D marking; extruding it
            // would put a block-high slab over ground where nothing is built.
            if (feature.properties && feature.properties.kind === 'plot') return;
            const declared = Number(feature.properties && feature.properties.height);
            const height = declared > 0 ? declared : estimateBuildingHeightMeters(feature);
            try { createBuildingSlices(feature, height, buildingMaterials.massing, targetGroup); } catch (_) { }
        });
    }

    // Source glTF assets are shared by placements and stay cached only for this 3D scene lifetime.
    // Teardown clears the cache after placed objects are detached; late loads self-dispose.
    const gltfModelCache = threeResources.createSceneCache(threeResources.disposeSharedSubtree);
    let buildingsRenderGeneration = 0;

    function loadGltfScene(url) {
        return gltfModelCache.load(url, () => new Promise((resolve, reject) => {
            const LoaderCtor = (typeof THREE !== 'undefined' && THREE.GLTFLoader) ? THREE.GLTFLoader : null;
            if (!LoaderCtor) { reject(new Error('GLTFLoader unavailable')); return; }
            new LoaderCtor().load(
                url,
                (gltf) => resolve(gltf.scene || (gltf.scenes && gltf.scenes[0]) || null),
                undefined,
                (err) => reject(err)
            );
        }));
    }

    // Fit an uploaded glTF's native XY footprint to the authored polygon. Polygon coordinates
    // already include the scene's Web-Mercator scale, so each horizontal axis is fitted directly;
    // vertical scale uses the authored height in metres. `rotation` is counter-clockwise degrees,
    // matching the single-building footprint editor.
    function uploadedModelFit(feature, centerXY, nativeSize) {
        const geometry = feature?.geometry;
        if (!geometry || !centerXY || !nativeSize) return null;
        const properties = feature.properties || {};
        const rotationDeg = Number(properties.rotation) || 0;
        const radians = rotationDeg * Math.PI / 180;
        const cos = Math.cos(radians), sin = Math.sin(radians);
        const points = [];
        const coordinates = geometry.type === 'Polygon' ? [geometry.coordinates]
            : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
        coordinates.forEach(polygon => polygon.forEach(ring => ring.forEach(coordinate => {
            const xy = latLngToXY(coordinate[1], coordinate[0]);
            const dx = xy[0] - centerXY[0], dy = xy[1] - centerXY[1];
            points.push([dx * cos + dy * sin, -dx * sin + dy * cos]);
        })));
        if (!points.length) return null;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        points.forEach(([x, y]) => {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        });
        const width = maxX - minX, depth = maxY - minY;
        const modelWidth = Number(nativeSize.x), modelDepth = Number(nativeSize.y), modelHeight = Number(nativeSize.z);
        const requestedHeight = Number(properties.heightMeters ?? properties.height);
        if (!(width > 0) || !(depth > 0) || !(modelWidth > 0) || !(modelDepth > 0) || !(modelHeight > 0)) return null;
        const height = requestedHeight > 0 ? requestedHeight : null;
        const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
        return {
            scale: [width / modelWidth, depth / modelDepth, height ? height / modelHeight : 1],
            rotation: radians,
            offset: [midX * cos - midY * sin, midX * sin + midY * cos]
        };
    }

    function disposeGltfCache() {
        gltfModelCache.clear();
    }

    // disposeScene is defined later in this closure; expose the cache owner so that full teardown
    // can evict its source assets after placement groups have released their clone materials.
    window.__threeModeDisposeGltfCache = disposeGltfCache;

    // Loads an uploaded building model and places it at the footprint centroid, grounded and
    // oriented (glTF Y-up → scene Z-up). Async: meshes pop in when the file finishes loading.
    function placeUploadedModel(feat, targetGroup, buildingMaterial, options = {}) {
        let cx = 0, cy = 0, lat = 0;
        try {
            const c = turf.centroid(feat);
            const [lng, latC] = c.geometry.coordinates;
            lat = latC;
            const xy = latLngToXY(lat, lng);
            cx = xy[0]; cy = xy[1];
        } catch (_) { return; }

        // A stored model reference is a served path; the backend this page talks to serves it.
        const url = (typeof resolveBackendAssetUrl === 'function')
            ? (resolveBackendAssetUrl(feat.properties.modelUrl) || feat.properties.modelUrl)
            : feat.properties.modelUrl;
        const gen = buildingsRenderGeneration;
        const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
        const buildingOpacity = buildingOpacityOf(buildingMaterial);
        const isProposedBuilding = targetGroup === proposedBuildingsGroup || targetGroup.userData?.buildingFamily === 'planned';
        const stale = () => !isActive || !isCurrent() || (isProposedBuilding && gen !== buildingsRenderGeneration);
        // The scene's XY is Web-Mercator (EPSG:3857), which inflates horizontal distance by
        // ~1/cos(lat) vs real meters, while extrude heights use raw meters. The glTF model is in
        // real meters, so scale its footprint (X/Y) by this factor to match surrounding buildings;
        // height (Z) stays 1:1.
        const trackLoading = isProposedBuilding;

        if (trackLoading) {
            pendingModelLoads++;
            updateBuildingsLoader();
        }
        loadGltfScene(url).then((scene) => {
            if (stale() || !scene) return;
            const inner = scene.clone(true);
            inner.rotation.x = Math.PI / 2; // glTF Y-up → scene Z-up
            inner.updateMatrixWorld(true);

            const box = new THREE.Box3().setFromObject(inner);
            if (box.isEmpty()) return;
            const center = new THREE.Vector3();
            box.getCenter(center);
            const size = new THREE.Vector3();
            box.getSize(size);
            // Center the footprint on the origin and sit the base on the ground (z=0).
            inner.position.set(-center.x, -center.y, -box.min.z);

            const wrapper = new THREE.Group();
            wrapper.add(inner);
            let fit = null;
            let placementX = cx, placementY = cy;
            if (options.fitToFootprint !== false) {
                const nativeSize = { x: size.x, y: size.y, z: size.z };
                const xyFit = uploadedModelFit(feat, [cx, cy], nativeSize);
                if (xyFit) fit = xyFit;
            }
            if (fit) {
                wrapper.scale.set(...fit.scale);
                wrapper.rotation.z = fit.rotation;
                placementX += fit.offset[0];
                placementY += fit.offset[1];
            } else {
                const horizScale = 1 / Math.max(0.1, Math.cos(lat * Math.PI / 180));
                wrapper.scale.set(horizScale, horizScale, 1);
            }
            wrapper.position.set(placementX, placementY, 0);

            // Collect before attaching depth children: mutating an Object3D hierarchy during
            // traverse would make the newly-added prepass meshes participate in this same walk.
            const modelMeshes = [];
            wrapper.traverse((node) => {
                if (node.isMesh && node.material) modelMeshes.push(node);
            });
            modelMeshes.forEach((node) => {
                if (options.cloneGeometry && node.geometry?.clone) {
                    node.geometry = markOwnedGeometry(node, node.geometry.clone());
                }
                // scene.clone(true) still shares glTF materials with the cache and other
                // placements. Clone each one before applying this display mode, then use the
                // same stable transparency path as generated building geometry.
                const sourceMaterials = Array.isArray(node.material) ? node.material : [node.material];
                const configuredMaterials = sourceMaterials.map((sourceMaterial) => {
                    if (!sourceMaterial) return sourceMaterial;
                    const cloned = sourceMaterial.clone();
                    cloned.userData.cbBuildingMaterialRole = buildingMaterial.userData.cbBuildingMaterialRole;
                    return configureBuildingMaterial(cloned, buildingOpacity);
                });
                node.material = Array.isArray(node.material) ? configuredMaterials : configuredMaterials[0];
                markOwnedMaterial(node, node.material);
                attachBuildingDepthPrepass(node);
            });
            targetGroup.add(wrapper);
            invalidateThreeView();
        }).catch((err) => {
            if (stale()) return;
            // A caller with its own fallback (a structure's procedural ground) draws that instead.
            if (typeof options.onLoadError === 'function') {
                try { options.onLoadError(err); } catch (fallbackError) {
                    console.warn('Model fallback failed:', url, fallbackError);
                }
                if (typeof console !== 'undefined') console.warn('Model load failed, used procedural fallback:', url, err);
                return;
            }
            // Fall back to the extruded box so the building is still visible.
            try {
                const height = estimateBuildingHeightMeters(feat);
                const fallbackMaterial = isProposedBuilding ? buildingMaterial : cloneBuildingMaterial(buildingMaterial);
                createBuildingSlices(feat, height, fallbackMaterial, targetGroup);
            } catch (_) { }
            if (typeof console !== 'undefined') console.warn('Building model load failed, used box fallback:', url, err);
        }).finally(() => {
            if (trackLoading && !stale()) {
                pendingModelLoads = Math.max(0, pendingModelLoads - 1);
                updateBuildingsLoader();
            }
            if (!stale()) invalidateThreeView();
        });
    }

    // A park, square or lake with an uploaded model (feature.properties.structureModel, from
    // ProposalApplyStructures.structureModelFeature) shows the model fitted to its authored
    // footprint instead of its procedural ground; its furniture still renders. buildGround draws
    // that procedural ground: at once without a model, or when the model fails to load.
    const structureModelGenerations = new WeakMap();
    function startStructureModels(decoTarget) {
        const generation = (structureModelGenerations.get(decoTarget) || 0) + 1;
        structureModelGenerations.set(decoTarget, generation);
        return () => structureModelGenerations.get(decoTarget) === generation;
    }

    function placeStructureModel(feature, decoTarget, isCurrent, buildGround) {
        const model = feature?.properties?.structureModel;
        if (!model?.geometry || typeof model.properties?.modelUrl !== 'string') {
            buildGround();
            return false;
        }
        placeUploadedModel(model, decoTarget, buildingMaterials.solid, { isCurrent, onLoadError: buildGround });
        return true;
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
    // Facade skins supply their own storey bands. Material visibility preserves parcel isolation.
    const facadeFloorLineMaterial = floorLineMaterial.clone();

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

    function addBuildingFloorLines(buildingFeature, height, targetGroup, hasFacade = false) {
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
        const lines = new THREE.LineSegments(geometry, hasFacade ? facadeFloorLineMaterial : floorLineMaterial);
        markOwnedGeometry(lines, geometry);
        lines.userData.isBuildingFloorLines = true;
        lines.userData.cbFacadeOwned = hasFacade;
        targetGroup.add(lines);
    }

    function prepareProceduralFacadeMeshes(meshes, owner, height, floorHeight, metresPerUnit, city, ownsMaterial = false, building = owner) {
        if (!owner || !meshes.length) return meshes;
        const design = buildingFacades.buildingDesign(buildingFacades.buildingKey(owner, city), height, floorHeight,
            buildingFacades.buildingIdentityKey(building, city));
        const facadeMaterial = buildingFacades.configureMaterial(
            ownsMaterial ? meshes[0].material : cloneBuildingMaterial(meshes[0].material), design, facadeState, THREE);
        meshes.forEach(mesh => {
            mesh.material = facadeMaterial;
            mesh.geometry.setAttribute('cbFacadeCoord', new THREE.Float32BufferAttribute(
                buildingFacades.wallCoordinates(mesh.geometry.attributes.position.array,
                    mesh.geometry.attributes.normal.array, metresPerUnit), 3));
            mesh.userData.cbFacadeOwned = true;
        });
        return meshes;
    }

    // `ruleDetails` (ruleRoofs.planFor) adds a rule's pitched roof, attic and balconies.
    function createBuildingSlices(buildingFeature, height, material, targetGroup, facadeSource = null, ruleDetails = null) {
        if (!buildingFeature?.geometry) return;
        if (ruleDetails) ruleRoofs.detailMeshes(ruleDetails, material).forEach(mesh => targetGroup.add(mesh));
        const hasFacade = !!facadeSource;
        const city = window.CityConfigManager?.getCurrentCityId?.() || '';
        const ruleFloorHeight = buildingFeature.properties?.urbanRule?.floorHeightM;
        const floorHeight = typeof ruleFloorHeight === 'number' && Number.isFinite(ruleFloorHeight) && ruleFloorHeight > 0
            ? ruleFloorHeight : (window.STOREY_HEIGHT_M || 3.3);
        const point = buildingFeature.geometry.type === 'MultiPolygon'
            ? buildingFeature.geometry.coordinates[0][0][0] : buildingFeature.geometry.coordinates[0][0];
        const metresPerUnit = Math.cos(point[1] * Math.PI / 180);
        const prepareFacades = (meshes, owner = facadeSource, ownsMaterial = false) => {
            // Preserve the authored identity across parcel slices.
            for (const mesh of meshes) {
                if (buildingFeature.properties?.proposalId) mesh.userData.proposalId = String(buildingFeature.properties.proposalId);
            }
            if (!hasFacade || !meshes.length) return meshes;
            // Each building keeps its style and glass tint; ownership seams vary only the shade.
            return prepareProceduralFacadeMeshes(meshes, owner, height, floorHeight, metresPerUnit, city, ownsMaterial, buildingFeature);
        };
        // A building keeps its own hue; parcel slices vary its shade rather than its planning role.
        const baseColor = new THREE.Color(stringToColor(JSON.stringify(buildingFeature.geometry.coordinates[0][0])));
        const drawUnsliced = () => {
            const tint = (targetGroup === proposedBuildingsGroup || targetGroup.userData?.buildingFamily === 'planned')
                && material !== buildingMaterials.massing;
            const surface = tint ? cloneBuildingMaterial(material) : material;
            if (tint) surface.color.copy(baseColor);
            const meshes = prepareFacades(polygonFeatureToMeshes(buildingFeature, surface, 0, height)
                .concat(ruleDetails ? ruleRoofs.atticMeshes(ruleDetails, buildingFeature, surface) : []), facadeSource, !!tint);
            if (tint && !meshes.length) surface.dispose();
            meshes.forEach(mesh => { if (tint && !hasFacade) markOwnedMaterial(mesh, surface); targetGroup.add(mesh); });
        };
        if (!window.LiveParcelFabric) { drawUnsliced(); return; }

        const candidateParcels = [];
        try {
            const bBbox = turf.bbox(buildingFeature);
            const fabric = window.LiveParcelFabric;
            (fabric?.queryBounds?.(bBbox, { includeCorridors: true }) || []).forEach(pf => {
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

        // Intersect the building with each candidate parcel and keep only the parcels it
        // actually covers (a bbox overlap is not enough — non-intersecting candidates would
        // otherwise desync the light/dark alternation). Each kept entry is one slice.
        const sliceData = [];
        candidateParcels.forEach((parcelFeature) => {
            let intersection = null;
            try {
                // Parcel cuts use this grid too. Raw authored coordinates against a rounded
                // remainder invent microscopic overlaps along an otherwise shared edge.
                intersection = window.__parcelArrangement.clip('intersect', buildingFeature, parcelFeature,
                    { site: 'three-mode.createBuildingSlices', parcelId: parcelFeature.properties?.parcelId });
            } catch (error) {
                // That parcel's slice is not drawn.
                reportThreeClip('intersect', error, 'three-mode.createBuildingSlices', [buildingFeature, parcelFeature]);
            }
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

                const sliceMeshes = prepareFacades(polygonFeatureToMeshes(sliceGeom, sliceMaterial, 0, height)
                    .concat(ruleDetails ? ruleRoofs.atticMeshes(ruleDetails, sliceGeom, sliceMaterial) : []), slice.parcelFeature, true);

                // Tag the slice with its parcel so parcel-isolation can match the
                // building footprint sitting on a clicked parcel.
                const sliceParcelId = (slice.parcelFeature.properties && slice.parcelFeature.properties.parcelId != null)
                    ? String(slice.parcelFeature.properties.parcelId) : null;

                sliceMeshes.forEach(mesh => {
                    if (!hasFacade) markOwnedMaterial(mesh, sliceMaterial);
                    if (sliceParcelId) mesh.userData.parcelId = sliceParcelId;
                    pendingSliceObjects.push(mesh);
                    const edges = new THREE.EdgesGeometry(mesh.geometry);
                    const line = new THREE.LineSegments(edges, materials.sliceEdges);
                    markOwnedGeometry(line, edges);
                    line.userData.cbFacadeOwned = hasFacade;
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
                buildingFacades.disposeGroup(pendingSliceObjects);
                threeResources.disposeOwnedSubtree(pendingSliceObjects);
            }
            drawUnsliced();
        }

        // Storey divisions wrap the whole building once, whether it drew sliced or unsliced.
        try { addBuildingFloorLines(buildingFeature, height, targetGroup, hasFacade); } catch (_) { }
    }

    function getBuildingParcelIntersectionPoints(buildingFeature) {
        const intersectionPoints = [];
        if (!buildingFeature || !buildingFeature.geometry) return intersectionPoints;
        if (!window.LiveParcelFabric) return intersectionPoints;

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

        const fabric = window.LiveParcelFabric;
        const buildingBbox = turf.bbox(buildingFeature);
        (fabric?.queryBounds?.(buildingBbox, { includeCorridors: true }) || []).forEach(pf => {
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
                markOwnedGeometry(line, geometry);
                line.renderOrder = 9999;
                lines.push(line);
            } catch (e) { console.warn('Failed to create vertical line', e); }
        });
        return lines;
    }

    // A replaced building group is released after the frame that first draws its replacement. Its
    // materials hold the shared shader programs until the new ones have taken them over; releasing
    // it at once deleted those programs and relinked them on the next frame (50–130 ms frames on
    // every rebuild, e.g. each build-out month step).
    const retiredGroups = [];
    function retireGroupAfterFrame(group) {
        retiredGroups.push(group);
        invalidateThreeView();
    }
    function releaseRetiredGroups() {
        while (retiredGroups.length) clearGroupChildren(retiredGroups.pop());
    }

    function clearGroupChildren(group) {
        if (!group) return;
        buildingFacades.disposeGroup(group);
        threeResources.disposeOwnedSubtree(group);
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
        // The pavement fill follows the same terrain the strips do, so photo view shows the road at
        // the width the editor drew it.
        try { buildCorridorEdgeFills3D(group, sampleHeight); } catch (error) {
            console.warn('[three-mode] terrain corridor edge fills failed', error);
        }
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
        applyParcelEmphasis();
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

    function disposeFloorPlans() {
        if (floorPlanGroup) {
            [...floorPlanGroup.children].forEach(group => {
                floorPlanRenderer.disposeGroup(group);
                floorPlanGroup.remove(group);
            });
        }
        renderedFloorPlanKeys.clear();
        floorPlanErrors = 0;
        Object.assign(suggestedPlanTotals, { buildings: 0, slices: 0, flagged: 0, apartments: 0, cores: 0, pendingStreets: false, existing: 0, existingCapped: false });
        suggestedPlanByParcel.clear();
        suggestedPlanByProposal.clear();
    }

    // The regulation region of the current city, read from the locale its configuration carries.
    function suggestedRegion() {
        try { return suggestedPlanContext?.regionOf?.(window.CityConfigManager?.getCurrentCityConfig?.()) || null; } catch (_) { return null; }
    }

    // Everything that counts as a road for choosing an entrance side: street centrelines for the
    // building's cell (fetched once), the plan's own applied corridors, and road parcels of the
    // fabric. Each source is optional; a city with none of them falls back to the longest facade.
    function suggestedRoadsFor(feature) {
        const roads = [];
        const streets = suggestedStreetsFor(feature);
        if (Array.isArray(streets)) roads.push(...streets);
        try {
            if (typeof proposalStorage !== 'undefined' && typeof isAppliedCorridorProposal === 'function' && typeof corridorProposalDefinition === 'function') {
                proposalStorage.getAllProposals().filter(isAppliedCorridorProposal).forEach(proposal => {
                    corridorRenderEntriesForDefinition(corridorProposalDefinition(proposal)).forEach(entry => {
                        const coordinates = entry.points.map(point => [Number(point.lng), Number(point.lat)]).filter(p => p.every(Number.isFinite));
                        if (coordinates.length >= 2) roads.push({ type: 'Feature', geometry: { type: 'LineString', coordinates },
                            properties: { proposalId: proposal.proposalId ?? proposal.id ?? null, title: proposal.title || proposal.name || null, source: 'corridor' } });
                    });
                });
            }
        } catch (_) { }
        try {
            const bbox = turf.bbox(feature);
            const pad = 0.0006; // about 50 m
            (window.LiveParcelFabric?.queryBounds?.([bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad], { includeCorridors: true }) || []).forEach(parcel => {
                const props = parcel?.properties || {};
                const id = props.parcelId ?? props.parcel_id ?? props.id;
                const road = props.isCorridor === true || props.isRoad === true || props.isTrack === true
                    || (typeof window.isRoadParcel === 'function' && id != null && window.isRoadParcel(String(id)));
                if (road && parcel.geometry) roads.push(parcel);
            });
        } catch (_) { }
        return roads;
    }

    // Record one planned slice for the panels: by parcel (the clicked building) and by proposal.
    function recordSuggestedSlice(owner, slice, floors) {
        const result = slice.result;
        if (slice.parcelId != null) {
            const key = String(slice.parcelId);
            const entry = suggestedPlanByParcel.get(key) || { slices: [] };
            entry.slices.push({ result, floors, wing: slice.wing });
            suggestedPlanByParcel.set(key, entry);
        }
        const proposalId = owner?.properties?.proposalId;
        if (proposalId === undefined || proposalId === null) return;
        const totals = suggestedPlanByProposal.get(String(proposalId)) || { buildings: 0, flagged: 0, apartmentsPerFloor: 0, apartments: 0, cores: 0 };
        if (result.floorPlans) {
            totals.buildings++;
            totals.cores += result.summary.cores;
            totals.apartmentsPerFloor += result.summary.apartmentsPerFloor;
            totals.apartments += result.floorPlans.floors.reduce((sum, floor) => sum + (floor.apartments || []).length, 0);
        } else totals.flagged++;
        suggestedPlanByProposal.set(String(proposalId), totals);
    }

    // One line for the parcel and proposal panels, or '' when suggestions are off or absent.
    function suggestedParcelPanelText(parcelId) {
        if (!suggestedPlansEnabled || parcelId == null) return '';
        const entry = suggestedPlanByParcel.get(String(parcelId));
        if (!entry) return '';
        const planned = entry.slices.filter(slice => slice.result.floorPlans);
        if (!planned.length) {
            const reason = entry.slices.flatMap(slice => slice.result.warnings).find(w => w.severity === 'error');
            return threeI18n('threeMode.parcelPanel.suggestedFlagged', `No default layout fits: ${reason ? reason.message : ''}`, { reason: reason ? reason.message : '' });
        }
        const cores = planned.reduce((sum, slice) => sum + slice.result.summary.cores, 0);
        const apartments = planned.reduce((sum, slice) => sum + slice.result.summary.apartmentsPerFloor, 0);
        const rooms = planned.reduce((sum, slice) => sum + (slice.result.summary.rooms || 0), 0);
        return threeI18n('threeMode.parcelPanel.suggestedSummary', `${cores} core(s) · ${apartments} apartments per floor · ${rooms} rooms`, { cores, apartments, rooms });
    }
    function suggestedProposalPanelText(proposal) {
        if (!suggestedPlansEnabled || !proposal) return '';
        const totals = suggestedPlanByProposal.get(String(proposal.proposalId ?? proposal.id));
        if (!totals || (!totals.buildings && !totals.flagged)) return '';
        const line = threeI18n('threeMode.proposalPanel.suggestedTotals',
            `Suggested layouts: ${totals.buildings} buildings · ${totals.apartmentsPerFloor} apartments per floor · ${totals.apartments} in total`,
            { buildings: totals.buildings, apartmentsPerFloor: totals.apartmentsPerFloor, apartments: totals.apartments });
        return totals.flagged ? `${line} ${threeI18n('threeMode.controls.suggestedFlagged', `${totals.flagged} in red: too small for a minimum stair core.`, { count: totals.flagged })}` : line;
    }

    // Street centrelines for the cell a building sits in, fetched once per cell. Until they arrive the
    // entrance faces the longest facade; their arrival drops the plan cache and rebuilds once.
    function suggestedStreetsFor(feature) {
        if (!suggestedPlanContext) return null;
        const cellKey = suggestedPlanContext.streetCellKey(feature, turf);
        if (!cellKey) return null;
        const cell = suggestedStreetCells.get(cellKey);
        if (cell && cell.features) return cell.features;
        if (!cell) {
            suggestedStreetCells.set(cellKey, { features: null, pending: true });
            const base = (typeof window.getBackendBase === 'function') ? window.getBackendBase() : '';
            const bbox = suggestedPlanContext.streetCellBbox(cellKey);
            fetch(`${base}/streets/near?bbox=${encodeURIComponent(bbox.join(','))}`)
                .then(response => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
                .then(data => {
                    const features = Array.isArray(data && data.features) ? data.features : [];
                    suggestedStreetCells.set(cellKey, { features, pending: false });
                    suggestedPlanCache.clear();
                    if (isActive && xrayEnabled && suggestedPlansEnabled) rebuild3DBuildingsOnly();
                })
                .catch(error => {
                    console.warn(`[${new Date().toISOString()}] [3D] Street lookup for suggested layouts failed; entrances face the longest facade.`, error);
                    suggestedStreetCells.set(cellKey, { features: [], pending: false, failed: true });
                    suggestedPlanCache.clear();
                    if (isActive && xrayEnabled && suggestedPlansEnabled) rebuild3DBuildingsOnly();
                });
        }
        suggestedPlanTotals.pendingStreets = true;
        return null;
    }

    // One generated default layout per parcel slice of a proposed building (one parcel, one
    // building), or a red volume where the minimum core does not fit. The floorPlans object exists
    // only in the scene and the cache; the proposal's own record is never touched.
    function appendSuggestedFloorPlans(feature, buildingMaterial, targetGroup, variationDeps) {
        if (!xrayEnabled || !suggestedPlansEnabled || !floorPlanGroup || !suggestedFloorPlans || !suggestedPlanContext) return false;
        if (!feature?.geometry || feature.properties?.modelUrl || feature.properties?.floorPlans) return false;
        // The suggested layout is a housing layout: a building stated for another use gets none, and
        // a stated housing use sets its ground floor (building-use.js).
        const use = window.BuildingUse.normalize(feature.properties?.use);
        if (use && !window.BuildingUse.housesPeople(use)) return false;
        let plan;
        try { plan = window.UrbanRuleVariation.plannedDrawPlan(feature, plannedRepresentation, variationDeps, buildOutDisplaySalt); } catch (_) { return false; }
        const subject = plan.buildOut || plan.massing;
        if (!subject?.geometry) return false;
        const height = estimateBuildingHeightMeters(subject);
        let parcels = [];
        try { parcels = window.LiveParcelFabric?.queryBounds?.(turf.bbox(subject), { includeCorridors: true }) || []; } catch (_) { parcels = []; }
        // The facade design's bay width sets the room rhythm, so interior windows and the painted
        // exterior fall into the same bays when both are shown.
        let facadeBayWidthM = null;
        try {
            const city = window.CityConfigManager?.getCurrentCityId?.() || '';
            facadeBayWidthM = buildingFacades.buildingDesign(buildingFacades.buildingKey(feature, city), height, window.STOREY_HEIGHT_M || 3.3).bayWidth;
        } catch (_) { facadeBayWidthM = null; }
        let planned;
        try {
            planned = suggestedPlanContext.planBuilding(subject, {
                owner: feature, parcels, turf, generator: suggestedFloorPlans, region: suggestedRegion(),
                roads: suggestedRoadsFor(subject), heightM: height, storeyFallbackM: window.STOREY_HEIGHT_M || 3.3,
                neighbours: suggestedPlanContext.neighbourPool(feature, window.proposedBuildings, window.buildingFeaturePool, turf),
                cache: suggestedPlanCache, rules: facadeBayWidthM || use ? { ...(facadeBayWidthM ? { facadeBayWidthM } : {}), ...(use ? window.BuildingUse.layoutRules(use) : {}) } : undefined
            });
        } catch (error) {
            floorPlanErrors++;
            console.error(`[${new Date().toISOString()}] [3D] Suggested layout failed for building`, feature.properties?.name, error);
            return false;
        }
        suggestedPlanTotals.buildings++;
        for (const slice of planned.slices) {
            suggestedPlanTotals.slices++;
            const result = slice.result;
            recordSuggestedSlice(feature, slice, planned.floors);
            if (result.floorPlans) {
                const modelled = { type: 'Feature', geometry: slice.footprint.geometry, properties: {
                    ...feature.properties, parcelId: slice.parcelId ?? feature.properties?.parcelId ?? null, floorPlans: result.floorPlans
                } };
                if (appendBuildingFloorPlans(modelled, buildingMaterial, result.summary.heightM)) {
                    suggestedPlanTotals.cores += result.summary.cores;
                    suggestedPlanTotals.apartments += result.summary.apartmentsPerFloor;
                    continue;
                }
            }
            suggestedPlanTotals.flagged++;
            try {
                polygonFeatureToMeshes(slice.footprint, buildingMaterials.flagged, 0, height).forEach(mesh => {
                    if (slice.parcelId != null) mesh.userData.parcelId = String(slice.parcelId);
                    mesh.userData.cbSuggestedLayoutWarnings = result.warnings;
                    targetGroup.add(mesh);
                });
            } catch (_) { }
        }
        if (plan.massing && plan.massingStyle === 'envelope') {
            try { createBuildingSlices(plan.massing, estimateBuildingHeightMeters(plan.massing), buildingMaterials.massing, targetGroup, null); } catch (_) { }
        }
        return true;
    }

    function setSuggestedPlansEnabled(enabled) {
        suggestedPlansEnabled = enabled === true;
        rebuild3DBuildingsOnly();
        updateXrayControls();
    }

    function setSuggestedExistingEnabled(enabled) {
        suggestedExistingEnabled = enabled === true;
        rebuild3DBuildingsOnly();
        updateXrayControls();
    }

    // Typical layouts by era for the existing buildings in the loaded radius, drawn inside their
    // (transparent) built volumes. Footprints come from the 2D pool; a footprint without a height
    // gets nothing, and buildings being replaced by a proposal are skipped.
    function appendSuggestedExistingFloorPlans(buildingMaterial) {
        if (!xrayEnabled || !suggestedPlansEnabled || !suggestedExistingEnabled || !floorPlanGroup || !suggestedFloorPlans || !suggestedPlanContext) return;
        const pool = Array.isArray(window.buildingFeaturePool) ? window.buildingFeaturePool : [];
        if (!pool.length) return;
        const view = getGeoCameraView();
        if (!view) return;
        const centre = turf.point([view.targetLng, view.targetLat]);
        const proposed = Array.isArray(window.proposedBuildings) ? window.proposedBuildings : [];
        const storeyM = window.STOREY_HEIGHT_M || 3.3;
        let count = 0;
        for (const feature of pool) {
            if (!feature?.geometry) continue;
            if (count >= SUGGESTED_EXISTING_CAP) { suggestedPlanTotals.existingCapped = true; break; }
            let within = false;
            try { within = turf.distance(centre, turf.centroid(feature), { units: 'meters' }) <= buildingLoadRadiusM; } catch (_) { within = false; }
            if (!within) continue;
            const props = feature.properties || {};
            // The pool carries height_m and floors; a footprint with neither stays a plain volume.
            const height = Number.isFinite(props.height_m) && props.height_m > 0 ? props.height_m
                : Number.isFinite(props.floors) && props.floors > 0 ? props.floors * storeyM
                : (props.height || props.levels || props.storeys) ? estimateBuildingHeightMeters(props) : null;
            if (!height) continue;
            // A footprint a proposal builds over is being replaced; its interior is not worth guessing.
            let replaced = false;
            try {
                const bbox = turf.bbox(feature);
                replaced = proposed.some(building => {
                    if (!building?.geometry) return false;
                    const other = turf.bbox(building);
                    if (other[2] < bbox[0] || other[0] > bbox[2] || other[3] < bbox[1] || other[1] > bbox[3]) return false;
                    let overlap = null;
                    try { overlap = turf.intersect(feature, building); } catch (error) {
                        // Taken as not replaced: the suggested interior is drawn.
                        reportThreeClip('intersect', error, 'three-mode.appendSuggestedExistingFloorPlans', [feature, building]);
                        return false;
                    }
                    return !!overlap && turf.area(overlap) > 1;
                });
            } catch (_) { replaced = false; }
            if (replaced) continue;
            let planned;
            try {
                planned = suggestedPlanContext.planBuilding(feature, {
                    owner: feature, existing: true, parcels: [], turf, generator: suggestedFloorPlans, region: suggestedRegion(),
                    roads: suggestedRoadsFor(feature), heightM: height, storeyFallbackM: storeyM,
                    neighbours: suggestedPlanContext.neighbourPool(feature, proposed, pool, turf), cache: suggestedPlanCache
                });
            } catch (error) {
                floorPlanErrors++;
                console.error(`[${new Date().toISOString()}] [3D] Suggested layout failed for an existing building`, props.id, error);
                continue;
            }
            count++;
            for (const slice of planned.slices) {
                if (!slice.result.floorPlans) continue;
                const modelled = { type: 'Feature', geometry: slice.footprint.geometry, properties: { ...props, floorPlans: slice.result.floorPlans } };
                if (appendBuildingFloorPlans(modelled, buildingMaterial, Math.max(0.1, slice.result.summary.heightM - 0.002), feature)) suggestedPlanTotals.existing++;
            }
        }
    }

    function appendBuildingFloorPlans(feature, proxyMaterial, proxyHeightM, inspectionFeature = null) {
        const plans = feature?.properties?.floorPlans;
        if (!xrayEnabled || !floorPlanGroup || !plans) return false;
        // A building can have several parcel slices or appear in both data families. Its
        // registered drawing is owned once, independent of how many exterior meshes it has.
        try {
            const key = JSON.stringify([plans.registration, plans.floors?.map(floor => floor.id)]);
            if (renderedFloorPlanKeys.has(key)) return true;
            const group = floorPlanRenderer.createBuildingGroup(THREE, feature,
                (lng, lat) => latLngToXY(lat, lng), floorPlanGeometry, { proxyMaterial, proxyHeightM });
            if (group) {
                if (inspectionFeature) group.userData.planningBuiltFeature = inspectionFeature;
                floorPlanRenderer.setCutaway(group, floorCutawayLevel);
                floorPlanGroup.add(group);
                renderedFloorPlanKeys.add(key);
                return true;
            }
        } catch (error) {
            floorPlanErrors++;
            console.error('[3D] Invalid floor plans for building', feature.properties?.name, error);
        }
        return false;
    }

    function renderScene(fullFrame = true, { shadowsPerPass = false } = {}) {
        // Entry tilt, restored cameras and captures need the same lighting as the steady loop.
        // `sceneChanged`: something in the scene changed since the last render (a rebuild, a proposal, a
        // selection), which is when the shadow map is re-rendered; a frame that only orbits the camera
        // or animates a hook keeps it.
        // Tree tiers follow the camera; their shadows come from fixed stand-ins, so no shadow redraw.
        retierTreesIfMoved();
        sunLayer?.beforeRender({ fullFrame, sceneChanged: renderedSceneVisualRevision !== sceneVisualRevision });
        // A comparison pass shows a different set of objects: its shadows are its own.
        if (shadowsPerPass && renderer.shadowMap.enabled) renderer.shadowMap.needsUpdate = true;
        updateLampGlow();
        updateSkyAndWindows();
        floorPlanRenderer.renderCutaway(renderer, scene, camera, floorPlanGroup,
            xrayEnabled && floorCutawayLevel !== null && floorCutawayLevel < 0);
        renderedBuildingDisplaySnapshot = buildingDisplaySnapshot;
        renderedSceneVisualRevision = sceneVisualRevision;
    }

    // ── Side by side comparison (three-compare.js) ─────────────────────────────────────────────
    // The canvas splits at the divider; each half draws one chosen state of this scene from the
    // same camera. Only objects the two sides disagree on are switched between the passes.
    let compareSplit = null;

    function compareDesignIdOf(object) {
        let found = null;
        object.traverse(node => { if (!found && node.userData?.proposalId != null) found = String(node.userData.proposalId); });
        return found;
    }

    // The two sides' plan members that no applied design stands for, once read (compare-unapplied.js).
    function compareUnappliedParts() {
        const compare = window.ThreeCompare, unapplied = window.CompareUnapplied;
        if (!compare?.isActive?.() || !unapplied) return [];
        const { left, right } = compare.sides();
        return [unapplied.partOf(left), unapplied.partOf(right)].filter(Boolean);
    }

    // The footprint an existing building's meshes were built from, and its id.
    function observedFootprintOf(object) {
        let feature = null;
        object.traverse(node => { if (!feature && node.userData?.planningBuiltFeature) feature = node.userData.planningBuiltFeature; });
        return feature ? { feature, id: clickedBuildingId(feature) } : null;
    }

    // Every scene object a side may hide, with what it stands for. Objects hidden anyway (a display
    // setting, isolation) are left out, so a pass never shows what the person switched off.
    function compareDescriptors() {
        const descriptors = [];
        const outcomes = window.currentBuildingOutcomeState?.();
        const parts = compareUnappliedParts();
        const designIdOfRecord = record => {
            const by = record?.proposalKey || record?.proposalId;
            if (!by) return null;
            const proposal = window.getProposalByIdOrHash?.(by) || window.proposalStorage?.getProposal?.(by);
            return proposal ? String(proposalIdOf(proposal)) : String(by);
        };
        const each = (group, make, { evenHidden = false } = {}) => {
            if (!group || (!evenHidden && group.visible === false)) return;
            for (const child of group.children) {
                if (child.visible === false) continue;
                const descriptor = make(child);
                if (descriptor) descriptors.push({ object: child, ...descriptor });
            }
        };
        each(existingBuildingsGroup, child => {
            const observed = observedFootprintOf(child);
            const record = observed ? outcomes?.demolishedById.get(observed.id) : null;
            const demolishedBy = [];
            // The surviving remainder of a cut building stands on every side; the condemned part
            // goes with the design that demolishes it.
            if (record && child.userData?.demolitionPart !== 'remainder') demolishedBy.push({ id: designIdOfRecord(record), unapplied: false });
            if (observed) for (const part of parts) demolishedBy.push(...part.cutsOf(observed.id, observed.feature));
            return { role: 'existing', demolishedBy };
        });
        each(planningSourcesGroup, () => ({ role: 'permitted' }));
        for (const group of [proposedBuildingsGroup, ineligibleBuildingsGroup, floorPlanGroup, plannedFlatGroup, parkGroundGroup,
            squareGroundGroup, lakeGroundGroup, proposalGroundGroup, parcelLayoutGroup, parkGroup, squareGroup, lakeGroup,
            stationGroup, corridorGroup, terrainCorridorGroup]) {
            each(group, child => ({ role: 'proposed', designId: compareDesignIdOf(child) }));
        }
        // What the plan sides draw of their unapplied members: hidden outside the passes, so read anyway.
        each(compareUnappliedGroup, child => ({ role: 'proposed', designId: compareDesignIdOf(child), unapplied: true }), { evenHidden: true });
        return descriptors;
    }

    // ── what a plan side draws of members not on the map ─────────────────────────────────────
    // Built once per choice of sides and read state: each unapplied member's buildings as the
    // proposed buildings are built (sliced by parcel, in the Proposed material), its road corridor
    // and its park, square, lake or station ground as flat plates, and what is left of each
    // standing building it cuts, as a prism at that building's height. Every mesh carries the
    // member's design CID as its proposalId, so the passes switch it like an applied design's.
    let compareUnappliedKey = null;
    const compareUnappliedMaterials = {};
    function compareUnappliedMaterial(kind) {
        if (!compareUnappliedMaterials[kind]) {
            const colors = { road: 0x4b5563, park: 0x3f7d3a, square: 0xb8b2a6, lake: 0x3b82c4, station: 0x7c6f9f };
            compareUnappliedMaterials[kind] = new THREE.MeshLambertMaterial({ color: colors[kind] ?? colors.square, side: THREE.DoubleSide });
        }
        return compareUnappliedMaterials[kind];
    }

    function refreshCompareUnapplied3D() {
        if (!compareUnappliedGroup) return;
        const parts = compareUnappliedParts();
        const key = parts.map(part => part.rows.map(row => row.proposalId).join(',')).join('|');
        if (key === compareUnappliedKey) return;
        compareUnappliedKey = key;
        clearGroupChildren(compareUnappliedGroup);
        const material = plannedDisplay === 'solid' ? buildingMaterials.solid : buildingMaterials.ghost;
        const drawn = new Set(), cutBuildings = new Set();
        let buildings = 0, plates = 0, remainders = 0;
        for (const part of parts) {
            for (const row of part.rows) {
                const id = String(row.proposalId);
                if (drawn.has(id)) continue;
                drawn.add(id);
                (row.geometry?.buildings || []).forEach((building, index) => {
                    const feature = { ...building, properties: { ...(building.properties || {}), proposalId: id, buildingIndex: index } };
                    try {
                        const plan = window.UrbanRuleVariation.plannedDrawPlan(feature, plannedRepresentation, { turf }, buildOutDisplaySalt);
                        for (const [shape, envelope] of [[plan.buildOut, false], [plan.massing, plan.massingStyle === 'envelope']]) {
                            if (!shape) continue;
                            createBuildingSlices(shape, estimateBuildingHeightMeters(shape), envelope ? buildingMaterials.massing : material,
                                compareUnappliedGroup, envelope ? null : feature, null);
                            buildings += 1;
                        }
                    } catch (error) {
                        console.warn(`[${new Date().toISOString()}] [3D compare] a building of unapplied member ${id} was skipped`, error);
                    }
                });
                const plate = (kind, geometry) => {
                    if (!geometry) return;
                    polygonFeatureToMeshes({ type: 'Feature', properties: {}, geometry }, compareUnappliedMaterial(kind), 0.08, 0)
                        .forEach(mesh => { mesh.userData.proposalId = id; compareUnappliedGroup.add(mesh); plates += 1; });
                };
                plate('road', row.roadProposal?.definition?.polygon);
                plate(row.structureProposal?.kind || 'square', row.structureProposal?.geometry);
            }
            for (const child of existingBuildingsGroup?.children || []) {
                const observed = observedFootprintOf(child);
                if (!observed || cutBuildings.has(observed.id)) continue;
                for (const cut of part.cutsOf(observed.id, observed.feature)) {
                    if (!cut.remainder) continue;
                    cutBuildings.add(observed.id);
                    // The height of what stands there now; the scene is z-up.
                    const height = new THREE.Box3().setFromObject(child).getSize(new THREE.Vector3()).z || 3;
                    polygonFeatureToMeshes({ type: 'Feature', properties: {}, geometry: cut.remainder }, material, 0, height)
                        .forEach(mesh => { mesh.userData.proposalId = String(cut.by.id); compareUnappliedGroup.add(mesh); remainders += 1; });
                }
            }
        }
        if (parts.length) console.log(`[${new Date().toISOString()}] [3D compare] unapplied members: ${drawn.size} designs, ${buildings} buildings, ${plates} plates, ${remainders} cut remainders`);
        invalidateThreeView();
    }

    function renderComparePasses(fullFrame) {
        const compare = window.ThreeCompare;
        const { left, right, percent } = compare.sides();
        if (!compareSplit || compareSplit.revision !== sceneVisualRevision) {
            compareSplit = { revision: sceneVisualRevision, ...compare.splitDescriptors(left, right, compareDescriptors()) };
        }
        const size = renderer.getSize(new THREE.Vector2());
        const rects = compare.scissorRects(size.x, size.y, percent);
        const switched = [...compareSplit.leftOnly, ...compareSplit.rightOnly, ...compareSplit.hidden];
        compareSplit.hidden.forEach(item => { item.object.visible = false; });
        if (compareUnappliedGroup) compareUnappliedGroup.visible = true;
        renderer.setScissorTest(true);
        try {
            for (const side of ['left', 'right']) {
                compareSplit.leftOnly.forEach(item => { item.object.visible = side === 'left'; });
                compareSplit.rightOnly.forEach(item => { item.object.visible = side === 'right'; });
                renderer.setScissor(...rects[side]);
                renderScene(fullFrame, { shadowsPerPass: !!sunLayer });
            }
        } finally {
            renderer.setScissorTest(false);
            renderer.setScissor(0, 0, size.x, size.y);
            if (compareUnappliedGroup) compareUnappliedGroup.visible = false;
            switched.forEach(item => { item.object.visible = true; });
        }
    }

    // One frame of the scene: the comparison's two passes when it is on, else the whole view.
    function drawFrame(fullFrame) {
        if (window.ThreeCompare?.isActive?.()) renderComparePasses(fullFrame);
        else { compareSplit = null; renderScene(fullFrame); }
    }

    function setFloorCutaway(level) {
        if (level !== null && !Number.isInteger(level)) return;
        floorCutawayLevel = level;
        (floorPlanGroup?.children || []).forEach(group => floorPlanRenderer.setCutaway(group, level));
        updateXrayControls();
        invalidateThreeView();
    }

    function updateXrayControls() {
        if (xrayButton) xrayButton.setAttribute('aria-pressed', String(xrayEnabled));
        if (suggestedPlansButton) {
            suggestedPlansButton.hidden = !xrayEnabled;
            suggestedPlansButton.setAttribute('aria-pressed', String(suggestedPlansEnabled));
        }
        if (suggestedExistingRow) {
            suggestedExistingRow.hidden = !(xrayEnabled && suggestedPlansEnabled);
            if (suggestedExistingCheckbox) suggestedExistingCheckbox.checked = suggestedExistingEnabled;
        }
        if (floorCutawayControl) floorCutawayControl.hidden = !xrayEnabled;
        if (xrayEnabled && floorCutawaySelect) {
            const levels = [...new Set((floorPlanGroup?.children || []).filter(group => group.visible !== false)
                .flatMap(group => group.userData.availableLevels || []))].sort((a,b) => a-b);
            const signature = levels.join(',');
            if (floorCutawaySelect.dataset.levels !== signature) {
                floorCutawaySelect.replaceChildren();
                [null, ...levels].forEach(level => {
                    const option = document.createElement('option');
                    option.value = level === null ? 'all' : String(level);
                    option.textContent = level === null ? threeI18n('threeMode.controls.floorAll', 'All floors')
                        : level < 0 ? threeI18n('threeMode.controls.floorBasement', `Basement ${-level}`, { level: -level })
                        : level === 0 ? threeI18n('threeMode.controls.floorGround', 'Ground floor')
                        : threeI18n('threeMode.controls.floorLevel', `Floor ${level}`, { level });
                    floorCutawaySelect.appendChild(option);
                });
                floorCutawaySelect.dataset.levels = signature;
            }
            floorCutawaySelect.disabled = levels.length === 0;
            floorCutawaySelect.value = floorCutawayLevel === null ? 'all' : String(floorCutawayLevel);
        }
        if (!xrayNote) return;
        xrayNote.hidden = !xrayEnabled;
        if (!xrayEnabled) return;
        const totals = (floorPlanGroup?.children || []).reduce((total, group) => {
            const counts = floorPlanRenderer.summarize(group);
            Object.keys(total).forEach(key => { total[key] += counts[key]; });
            return total;
        }, { floors: 0, buildings: 0, estimatedFloors: 0, apartments: 0 });
        const lines = [totals.floors
            ? threeI18n('threeMode.controls.xrayCount', `Floors: ${totals.floors} · Buildings: ${totals.buildings}`, totals)
            : threeI18n('threeMode.controls.xrayEmpty', 'No floor plans available for the visible buildings.')];
        if (totals.estimatedFloors) lines.push(threeI18n('threeMode.controls.xrayEstimated',
            'Heights and opening types are inferred.'));
        if (floorPlanGroup?.children.some(group => group.visible && group.userData.registrationAccuracy === 'approximate')) {
            lines.push(threeI18n('threeMode.controls.xrayAlignment', 'Plan alignment is approximate.'));
        }
        if (floorPlanErrors) lines.push(threeI18n('threeMode.controls.xrayError',
            'Some floor plans could not be displayed.'));
        if (suggestedPlansEnabled) {
            lines.push(threeI18n('threeMode.controls.suggestedNote', 'Suggested layouts are generated defaults, not part of the design.'));
            const buildings = suggestedPlanTotals.slices - suggestedPlanTotals.flagged;
            if (buildings) lines.push(threeI18n('threeMode.controls.suggestedCount',
                `Suggested: ${buildings} buildings · ${suggestedPlanTotals.apartments} apartments per floor`,
                { buildings, apartments: suggestedPlanTotals.apartments }));
            if (suggestedPlanTotals.flagged) lines.push(threeI18n('threeMode.controls.suggestedFlagged',
                `${suggestedPlanTotals.flagged} in red: too small for a minimum stair core.`, { count: suggestedPlanTotals.flagged }));
            if (suggestedPlanTotals.pendingStreets) lines.push(threeI18n('threeMode.controls.suggestedPendingStreets',
                'Street data is loading; entrances face the longest facade until it arrives.'));
            if (suggestedExistingEnabled && suggestedPlanTotals.existing) lines.push(threeI18n('threeMode.controls.suggestedExistingCount',
                `Existing: ${suggestedPlanTotals.existing} buildings with a typical layout by era.`, { count: suggestedPlanTotals.existing }));
        }
        xrayNote.textContent = lines.join(' ');
    }

    function setXrayEnabled(enabled) {
        xrayEnabled = enabled === true;
        rebuild3DBuildingsOnly();
        updateXrayControls();
    }

    function applyRetainedBuildingDisplay() {
        if (!buildingDisplaySnapshot || buildingBuildPending || pendingModelLoads || xrayEnabled
            || BUILDING_GHOST_STYLE !== 'smooth' || !existingBuildingsGroup || !proposedBuildingsGroup) return false;
        const builtPolicy = buildingDisplayPolicy.resolveBuiltDisplayPolicy(builtDisplay, window.PlanningViews?.getState()?.existingScope);
        const existingVisible = builtPolicy.visible && !realisticLayerActive;
        const proposedVisible = realisticLayerActive || plannedDisplay !== 'off';
        const previous = buildingDisplaySnapshot;
        if (existingVisible && (!previous.existingReady
            || previous.builtPolicy.showSurviving !== builtPolicy.showSurviving
            || previous.builtPolicy.showDemolished !== builtPolicy.showDemolished)) return false;
        if (proposedVisible && !previous.proposedReady) return false;
        restoreParcelEmphasis();
        existingBuildingsGroup.visible = existingVisible;
        proposedBuildingsGroup.visible = proposedVisible;
        const update = (group, opacity, existing) => buildingDisplayPolicy.updateRetainedBuildingMaterials(group, {
            opacity, demolishedOpacity: opacity < 1 ? 0.3 : 1, existing, materials: buildingMaterials,
            configureMaterial: configureBuildingMaterial, attachDepthPrepass: attachBuildingDepthPrepass,
            depthFlag: smoothTransparency.DEPTH_PREPASS_FLAG
        });
        if (existingVisible) update(existingBuildingsGroup, builtPolicy.material === 'solid' ? 1 : 0.5, true);
        if (proposedVisible) update(proposedBuildingsGroup, plannedDisplay === 'solid' ? 1 : 0.5, false);
        if (existingTransitAlignmentGroup) existingTransitAlignmentGroup.visible = builtPolicy.showExistingRail && !realisticLayerActive;
        if (isolatedProposalId !== null) isolateProposal(isolatedProposalId);
        refreshClickStackFigures();
        invalidateThreeView();
        return true;
    }

    async function rebuild3DBuildingsOnly(options = {}) {
        if (!isActive || !buildingGroup) return;
        return buildingRefreshQueue.request(options.family || 'all');
    }

    async function build3DBuildingFamilies(requestedFamily) {
        if (!isActive || !buildingGroup) return;
        const family = xrayEnabled ? 'all' : requestedFamily;
        const rebuildExisting = family !== 'planned';
        const rebuildProposed = family !== 'existing';
        const previous = buildingDisplaySnapshot;
        buildingBuildPending = true;
        buildingDisplaySnapshot = null;
        restoreParcelEmphasis();
        // Build replacements off-scene. Cooperative work yields between buildings; clearing
        // the displayed groups first would expose an empty or partially rebuilt city each time.
        const nextExisting = rebuildExisting ? new THREE.Group() : existingBuildingsGroup;
        const nextProposed = rebuildProposed ? new THREE.Group() : proposedBuildingsGroup;
        nextExisting.name = 'ExistingBuildings';
        nextProposed.name = 'ProposedBuildings';
        nextProposed.userData.buildingFamily = 'planned';
        let committed = false;
        if (rebuildProposed) {
            clearGroupChildren(ineligibleBuildingsGroup);
            buildingsRenderGeneration++;
            pendingModelLoads = 0;
        }
        disposeFloorPlans();
        const generation = ++buildingsWorkGeneration;
        const signal = sceneAbort?.signal;
        const isCurrent = () => isActive && !signal?.aborted && generation === buildingsWorkGeneration;
        const builtPolicy = buildingDisplayPolicy.resolveBuiltDisplayPolicy(builtDisplay, window.PlanningViews?.getState()?.existingScope);
        const showExisting = builtPolicy.visible && !realisticLayerActive;
        const showProposed = realisticLayerActive || plannedDisplay !== 'off';
        const existingDataRevision = nearbyBuildingsRevision;
        let existingBuildFailures = rebuildExisting ? 0 : (previous?.existingBuildFailures || 0);
        nextExisting.visible = showExisting;
        nextProposed.visible = showProposed;
        if (existingTransitAlignmentGroup) existingTransitAlignmentGroup.visible = builtPolicy.showExistingRail && !realisticLayerActive;
        const existingMaterial = builtPolicy.material === 'solid' ? buildingMaterials.solid : buildingMaterials.ghost;
        const proposedMaterial = plannedDisplay === 'solid' ? buildingMaterials.solid : buildingMaterials.ghost;
        try {
            if (showExisting && rebuildExisting) {
                const result = await buildNearbyProposalBuildings3D(nextExisting, existingMaterial, {
                    showSurviving: builtPolicy.showSurviving,
                    showDemolished: builtPolicy.showDemolished
                }, isCurrent);
                existingBuildFailures = result?.failures || 0;
                if (!isCurrent()) return;
            }
            if (showProposed && rebuildProposed) await buildProposedBuildings3D(nextProposed, proposedMaterial, isCurrent);
            if (!isCurrent()) return;
            const replace = (previousGroup, nextGroup) => {
                if (previousGroup === nextGroup) return;
                buildingGroup.remove(previousGroup);
                buildingGroup.add(nextGroup);
                retireGroupAfterFrame(previousGroup);
                sunLayer?.syncObjects(nextGroup);
            };
            replace(existingBuildingsGroup, nextExisting);
            replace(proposedBuildingsGroup, nextProposed);
            existingBuildingsGroup = nextExisting;
            proposedBuildingsGroup = nextProposed;
            committed = true;
            if (showExisting) appendSuggestedExistingFloorPlans(existingMaterial);
            if (showIneligibleParcels && rebuildProposed) buildIneligibleParcels3D(ineligibleBuildingsGroup);
            buildingDisplaySnapshot = {
                builtPolicy,
                existingDataRevision: rebuildExisting ? existingDataRevision : previous?.existingDataRevision,
                existingBuildFailures,
                existingReady: rebuildExisting ? showExisting : !!previous?.existingReady,
                proposedReady: rebuildProposed ? showProposed : !!previous?.proposedReady
            };
            ensureNearbyProposalBuildings();
            ensureNearbyTrees();
            ensureNearbyWater();
            ensureNearbyGreen();
            if (isolatedParcelId !== null) applyParcelEmphasis();
            else if (isolatedProposalId !== null) isolateProposal(isolatedProposalId);
            refreshClickStackFigures();
            updateXrayControls();
            invalidateThreeView();
        } finally {
            if (!committed) {
                if (rebuildExisting) clearGroupChildren(nextExisting);
                if (rebuildProposed) clearGroupChildren(nextProposed);
            }
            if (generation === buildingsWorkGeneration) buildingBuildPending = false;
        }
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
        // is actually looking at.
        let bounds = null;
        if (typeof map !== 'undefined' && map) {
            try { bounds = map.getBounds(); } catch (_) { bounds = null; }
        }
        if (!bounds) return { width: 100, height: 100 };
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const [x0, y0] = latLngToXY(sw.lat, sw.lng);
        const [x1, y1] = latLngToXY(ne.lat, ne.lng);
        return { width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
    }

    async function initScene() {
        // Preserve pendingIntroAutoRotate across dispose/init cycle
        const preserveAutoRotate = pendingIntroAutoRotate;
        // Clean up if re-initializing
        disposeScene();
        // Restore the flag after dispose
        pendingIntroAutoRotate = preserveAutoRotate;
        if (pendingIntroAutoRotate) watchIntroAutoRotateStop(null);
        isTransitioning3D = true;
        sceneAbort = new AbortController();
        const signal = sceneAbort.signal;
        sceneReadyPromise = new Promise(resolve => { resolveSceneReady = resolve; });
        const ready = sceneReadyPromise;
        const isCurrent = () => isActive && !signal.aborted;

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
        sky = window.__threeSky.createSky(THREE, { pixelRatio: renderer.getPixelRatio() });
        scene.add(sky.group);
        threeContainer.innerHTML = '';
        threeContainer.appendChild(renderer.domElement);
        perfReadout = null;
        ensurePerfReadout();
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
        // The same light becomes the sun over the scene's place, with moving shadows (three-sun.js).
        sunLayer = window.__threeSun.attach({
            THREE, scene, renderer, light: dir, hemi,
            getOrigin: () => xyToLatLng(0, 0),
            getK: lifeMercatorK,
            getCamera: () => camera,
            getTarget: () => controls?.target || null,
            isPhotoActive: () => !!window.PhotorealMode?.isActive?.(),
            invalidate: () => invalidateThreeView(),
            excludedRoots: () => [lifeGroup],
            // The playing day keeps the loop running through a frame hook, like the life layer.
            addFrameHook: fn => window.registerThreeModeFrameHook(fn),
            removeFrameHook: fn => window.unregisterThreeModeFrameHook(fn)
        });

        // Groups
        flatGroup = new THREE.Group();
        corridorGroup = new THREE.Group();
        plannedFlatGroup = new THREE.Group();
        parkGroundGroup = new THREE.Group();
        squareGroundGroup = new THREE.Group();
        lakeGroundGroup = new THREE.Group();
        proposalGroundGroup = new THREE.Group();
        parcelLayoutGroup = new THREE.Group();
        plannedFlatGroup.add(parkGroundGroup, squareGroundGroup, lakeGroundGroup, proposalGroundGroup, parcelLayoutGroup);
        buildingGroup = new THREE.Group();
        buildingGroup.name = 'Buildings';
        existingBuildingsGroup = new THREE.Group(); existingBuildingsGroup.name = 'ExistingBuildings';
        planningSourcesGroup = new THREE.Group(); planningSourcesGroup.name = 'PermittedMassing';
        proposedBuildingsGroup = new THREE.Group(); proposedBuildingsGroup.name = 'ProposedBuildings';
        ineligibleBuildingsGroup = new THREE.Group(); ineligibleBuildingsGroup.name = 'IneligibleBuildings';
        buildingGroup.add(existingBuildingsGroup, proposedBuildingsGroup, ineligibleBuildingsGroup, planningSourcesGroup);
        floorPlanGroup = new THREE.Group();
        floorPlanGroup.name = 'FloorPlans';
        parkGroup = new THREE.Group();
        squareGroup = new THREE.Group();
        lakeGroup = new THREE.Group();
        stationGroup = new THREE.Group();
        treesGroup = new THREE.Group();
        waterGroup = new THREE.Group();
        greenGroup = new THREE.Group();
        proposalInteractionGroup = new THREE.Group();
        proposalDraftGroup = new THREE.Group();
        compareUnappliedGroup = new THREE.Group();
        compareUnappliedGroup.name = 'CompareUnapplied';
        compareUnappliedGroup.visible = false;
        compareUnappliedGroup.userData.buildingFamily = 'planned';
        treesEnabled = loadTreesEnabledPref();
        waterEnabled = loadWaterEnabledPref();
        greenEnabled = loadGreenEnabledPref();
        plannedRepresentation = window.PlanningViews.getState().proposedForm;
        buildOutDisplaySalt = window.PlanningViews.getState().proposedVariation;
        try {
            setFacadeAppearance(PersistentStorage.getItem(FACADE_PREF_KEY) === '1',
                PersistentStorage.getItem(FACADE_STYLE_KEY), false);
        } catch (_) { }
        treesGroup.visible = treesEnabled && !realisticLayerActive;
        waterGroup.visible = waterEnabled && !realisticLayerActive;
        greenGroup.visible = greenEnabled && !realisticLayerActive;
        scene.add(flatGroup);
        scene.add(corridorGroup);
        scene.add(plannedFlatGroup);
        scene.add(buildingGroup);
        scene.add(floorPlanGroup);
        scene.add(parkGroup);
        scene.add(squareGroup);
        scene.add(lakeGroup);
        scene.add(stationGroup);
        scene.add(treesGroup);
        scene.add(waterGroup);
        scene.add(greenGroup);
        scene.add(proposalInteractionGroup);
        scene.add(proposalDraftGroup);
        scene.add(compareUnappliedGroup);
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
        buildoutSites = computeBuildoutSites();
        const dataScope = JSON.stringify([window.CityConfigManager?.getCurrentCityId?.(), window.CityConfigManager?.getBuildingSourceId?.()]);
        if (dataScope !== nearbyDataScope) {
            nearbyProposalBuildings = []; nearbyProposalBuildingsKey = null;
            nearbyBuildingsOutcome = null; nearbyBuildingsProvenance = null;
            nearbyBuildingsRevision++;
            nearbyTrees = []; nearbyTreesKey = null;
            nearbyWater = []; nearbyWaterKey = null;
            nearbyGreen = []; nearbyGreenKey = null;
            nearbyDataScope = dataScope;
        }
        captureSceneLoadGeometry();
        // Ground covers the same frozen band as the nearby buildings, including room to orbit/pan.
        // A focused proposal can be away from Leaflet's view, so it owns its own snapshot bounds.
        const view = map.getBounds().pad(0.2);
        const viewBounds = [view.getWest(), view.getSouth(), view.getEast(), view.getNorth()];
        const anchorBounds = sceneLoadGeometry ? turf.bbox(turf.buffer(turf.feature(sceneLoadGeometry),
            buildingLoadRadiusM / 1000, { units: 'kilometers' })) : viewBounds;
        const queryBounds = isProposalFocusedEntry() ? anchorBounds : [
            Math.min(viewBounds[0], anchorBounds[0]), Math.min(viewBounds[1], anchorBounds[1]),
            Math.max(viewBounds[2], anchorBounds[2]), Math.max(viewBounds[3], anchorBounds[3])
        ];
        sceneParcelSnapshot = window.LiveParcelFabric.queryBounds(queryBounds, { includeCorridors: true });
        // Existing streets for the life layer load alongside everything else and join the
        // population when they arrive; nothing below waits for them. People keep to the band
        // where buildings are loaded, so nobody walks through a block that is not drawn yet.
        lifeQueryBounds = queryBounds;
        lifeAnchorBounds = anchorBounds;
        ensureLifeOsmRoads(queryBounds);
        // Loading the real-world context must not depend on a parcel or proposal mesh being
        // produced below. Explore has neither, but its frozen camera anchor is still a valid
        // /buildings/near query. Starting it here also leaves the rest of scene construction
        // free to fail independently of the context request.
        ensureNearbyProposalBuildings();
        const parcelGeneration = ++parcelGroundGeneration;
        await buildParcels3D(flatGroup, parcelGeneration, isCurrent);
        if (!isCurrent()) return false;
        buildRoads3D(flatGroup);
        // Corridors render into their own group (not flatGroup): in realistic mode the parcel
        // and road slabs hide behind the photoreal mesh while the corridor cross-sections stay.
        try { buildCorridorStrips3D(corridorGroup); } catch (error) { console.warn('[three-mode] corridor strips failed', error); }
        try { buildCorridorEdgeFills3D(corridorGroup); } catch (error) { console.warn('[three-mode] corridor edge fills failed', error); }
        const structureBuilds = [
            () => buildParks3D(parkGroundGroup, parkGroup),
            () => buildSquares3D(squareGroundGroup, squareGroup),
            () => buildLakes3D(lakeGroundGroup, lakeGroup),
            () => buildProposalGrounds3D(proposalGroundGroup),
            () => buildTransitStations3D(stationGroup),
            () => buildPlannedParcelLayout3D(parcelLayoutGroup)
        ];
        for (const buildStructure of structureBuilds) {
            if (!isCurrent()) return false;
            try { buildStructure(); } catch (error) { console.warn('[three-mode] structure build failed', error); }
            await new Promise(resolve => setTimeout(resolve, 0));
            if (!isCurrent()) return false;
        }
        try { buildExistingTransitAlignments3D(scene); } catch (error) { console.error('[three-mode] transit alignments failed', error); }
        // Apply initial visibility based on the current display states.
        const planningPolicy = window.PlanningViews?.getPolicy();
        if (planningPolicy) { builtDisplay = planningPolicy.existing; plannedDisplay = planningPolicy.proposed; }
        applyModeVisibility();
        await rebuild3DBuildingsOnly();
        rebuildPlanningSources3D();
        if (!isCurrent()) return false;
        buildingViewDirty = false;
        buildingWorkIncomplete = false;
        rebuildTreesOnly();
        rebuildWaterOnly();
        rebuildGreenOnly();
        try { rebuildLifeOnly(); } catch (error) { console.warn('[3D life] build failed', error); }
        rebuildProposalInteraction3D();
        rebuildProposalDraftPreview3D();

        // Camera framing that preserves current 2D view scale and center
        const content = computeContentBoundsXY();
        try {
            const diagonal = Math.max(1, Math.hypot(content.width, content.height));
            camera.far = Math.max(2000, diagonal * 8);
            camera.updateProjectionMatrix();

            // A ceiling on zooming out. OrbitControls defaults maxDistance to Infinity, so the
            // wheel kept going long after the city was a dot — out to where the near/far planes and
            // float precision give up and the screen is simply black. There is nothing to see out
            // there and no obvious way back, which reads as the app having broken.
            //
            // Measured from the scene's own diagonal, like camera.far above, so a small plan and a
            // whole city each get a ceiling that fits them rather than one tuned for the other. 3x
            // the diagonal frames everything with room to spare at a 45° FOV, and stays well inside
            // camera.far (8x) so the ground never clips as you approach the limit.
            //
            // The floor is 5 m: OrbitControls degenerates as the distance approaches zero — the
            // camera passes through its own target and the view flips — while 5 m is still close
            // enough to stand in a street between buildings.
            if (controls) {
                controls.minDistance = 5;
                controls.maxDistance = Math.max(1500, diagonal * 3);
            }
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
            if (!isCurrent()) return;
            // A shared scene can arrive while the initial tilt is running.
            // Finish entry at its saved pose instead of overwriting it on the next frame.
            if (pendingRestoreView && applyGeoCameraView(pendingRestoreView)) {
                pendingRestoreView = null;
                pendingIntroAutoRotate = false;
                renderScene();
                startLoop();
                return;
            }
            const t = Math.min(1, (now - start) / duration);
            const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad
            const pitch = finalPitchRad * ease;
            currentPitchRad = pitch;
            placeCameraForPitch(pitch);
            renderScene();
            if (t < 1) {
                frameId = requestAnimationFrame(tiltStep);
            } else {
                startLoop();
            }
        }
        // A shared render restores its exact camera pose (no intro tilt); everything else tilts in.
        if (pendingRestoreView && applyGeoCameraView(pendingRestoreView)) {
            pendingRestoreView = null;
            renderScene();
            startLoop();
        } else if (window.__reducedMotion) {
            // Reduced motion: land at the final tilt, no animation.
            pendingRestoreView = null;
            currentPitchRad = finalPitchRad;
            placeCameraForPitch(finalPitchRad);
            renderScene();
            startLoop();
        } else {
            pendingRestoreView = null;
            frameId = requestAnimationFrame(tiltStep);
        }

        // Resize handling
        window.addEventListener('resize', handleResize, { passive: true });
        resizeObserver = new ResizeObserver(handleResize);
        resizeObserver.observe(threeContainer);
        controls?.addEventListener('change', onCameraChange);
        controls?.addEventListener('change', () => window.dispatchEvent(new Event('threecamerachange')));
        controls?.addEventListener('start', onCameraChange);
        inputHandler = noteInput;
        renderer.domElement.addEventListener('pointermove', inputHandler, { passive: true });
        renderer.domElement.addEventListener('wheel', inputHandler, { passive: true });

        // Parcel selection emphasizes it in place; click empty/again or Escape to reset.
        // pointerdown records the press position so a click that ends a drag is ignored.
        parcelPointerDownHandler = (e) => { noteInput(); if (e.button === 0) clickDownXY = { x: e.clientX, y: e.clientY }; };
        renderer.domElement.addEventListener('pointerdown', parcelPointerDownHandler);
        parcelClickHandler = handleParcelClick;
        renderer.domElement.addEventListener('click', parcelClickHandler);
        if (!proposalSelectionUnsubscribe && window.ProposalSelection?.subscribe) {
            // One selection is several writes (clear, select, parcel) and the rebuild below walks
            // every applied proposal: the writes of one task coalesce into one rebuild.
            let rebuildQueued = false;
            proposalSelectionUnsubscribe = window.ProposalSelection.subscribe(() => {
                if (rebuildQueued) return;
                rebuildQueued = true;
                Promise.resolve().then(() => {
                    rebuildQueued = false;
                    if (!isActive) return;
                    rebuildProposalInteraction3D();
                    rebuildPlannedParcelLayout3D();
                });
            });
        }

        // Checkbox listeners (sync 3D buildings with the Layers sheet's state)
        const showExistingEl = document.getElementById('showBuildings');
        const showProposedEl = document.getElementById('showProposedBuildings');
        onShowExistingBuildingsChange = () => { rebuild3DBuildingsOnly(); };
        onShowProposedBuildingsChange = () => { rebuild3DBuildingsOnly(); };
        if (showExistingEl) showExistingEl.addEventListener('change', onShowExistingBuildingsChange);
        if (showProposedEl) showProposedEl.addEventListener('change', onShowProposedBuildingsChange);
        return ready;
    }

    // "Rendering…" while 3D initialises: the status line with its spinner (ephemerals.md).
    function showRenderingOverlay() {
        try {
            if (renderingStatusRelease) return;
            if (typeof updateStatus === 'function') updateStatus(threeI18n('threeMode.overlay.rendering', 'Rendering…'), { transient: true });
            renderingStatusRelease = (typeof beginStatusActivity === 'function') ? beginStatusActivity() : () => {};
        } catch (_) { }
        try { updateModeButtonStates(); } catch (_) { }
    }

    function hideRenderingOverlay() {
        try { if (renderingStatusRelease) renderingStatusRelease(); } catch (_) { }
        renderingStatusRelease = null;
        try { updateModeButtonStates(); } catch (_) { }
    }

    // The status line says so while built buildings load: the /buildings/near fetch (can pull
    // thousands of city meshes) and any uploaded glTF models still downloading (ephemerals.md).
    function updateBuildingsLoader() {
        try {
            // The same two waits as the Built and Proposed arcs around Buildings and massing.
            window.PlanningLoading?.set('existing', 'model', isActive && nearbyProposalBuildingsFetching);
            window.PlanningLoading?.set('proposed', 'model', isActive && pendingModelLoads > 0);
            const loading = isActive && (nearbyProposalBuildingsFetching || pendingModelLoads > 0);
            if (!loading) {
                if (buildingsLoaderRelease) {
                    // The hold ends with a word of its own: otherwise "Loading buildings…" would sit
                    // on the status line, spinner gone, until the idle fade or the next message.
                    buildingsLoaderRelease();
                    buildingsLoaderRelease = null;
                    // Said only when buildings came: an empty answer or a failure says so instead.
                    const closing = ['failed', 'partial', 'unsupported'].includes(nearbyBuildingsOutcome)
                        ? threeI18n('threeMode.overlay.buildingsFailed', 'Buildings could not be loaded')
                        : nearbyBuildingsOutcome === 'empty'
                            ? threeI18n('threeMode.overlay.noBuildings', 'No buildings found around here')
                            : threeI18n('threeMode.overlay.buildingsLoaded', 'Buildings loaded');
                    if (typeof updateStatus === 'function') updateStatus(closing);
                }
                buildingsLoaderText = '';
                return;
            }
            // The /near fetch is one request (no incremental total); pending glTF models are
            // countable, so that number rides along while any are still downloading.
            const label = threeI18n('threeMode.overlay.loadingBuildings', 'Loading buildings…')
                + (pendingModelLoads > 0 ? ` (${pendingModelLoads})` : '');
            if (label !== buildingsLoaderText && typeof updateStatus === 'function') updateStatus(label, { transient: true });
            buildingsLoaderText = label;
            if (!buildingsLoaderRelease && typeof beginStatusActivity === 'function') buildingsLoaderRelease = beginStatusActivity();
        } catch (_) { }
    }

    function stopIntroAutoRotate(suppressClick = false) {
        try {
            // The pointerdown that stops an ACTIVE intro rotation must not double as a map
            // click: it isolated whichever proposal sat under the cursor, hiding all others
            // (and, in realistic mode, gaping their carve holes open).
            if (suppressClick && ((controls && controls.autoRotate) || manualAutoRotateActive)) {
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

        watchIntroAutoRotateStop(controlsInstance);
    }

    function watchIntroAutoRotateStop(controlsInstance = controls) {
        const stop = event => {
            const canvasPress = ['pointerdown', 'mousedown', 'touchstart'].includes(event?.type)
                && event.target === renderer?.domElement;
            stopIntroAutoRotate(canvasPress);
        };

        // Stop as soon as the user clicks/touches/presses anywhere.
        try { document.addEventListener('pointerdown', stop, { passive: true, capture: true }); } catch (_) { }
        try { document.addEventListener('mousedown', stop, { passive: true, capture: true }); } catch (_) { }
        try { document.addEventListener('touchstart', stop, { passive: true, capture: true }); } catch (_) { }
        try { document.addEventListener('wheel', stop, { passive: true, capture: true }); } catch (_) { }
        try {
            if (controlsInstance && typeof controlsInstance.addEventListener === 'function') {
                controlsInstance.addEventListener('start', stop);
            }
        } catch (_) { }

        introAutoRotateCleanup = () => {
            try { document.removeEventListener('pointerdown', stop, true); } catch (_) { }
            try { document.removeEventListener('mousedown', stop, true); } catch (_) { }
            try { document.removeEventListener('touchstart', stop, true); } catch (_) { }
            try { document.removeEventListener('wheel', stop, true); } catch (_) { }
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

    let loopRunning = false;
    let renderInvalidated = false;
    let lastPlaneDist = 0;
    // While only frame hooks (the life layer, photo tiles) keep the loop alive and nothing is being
    // moved, frames come at HOOK_IDLE_FPS instead of the display's rate: the same motion at a
    // fraction of the battery cost. Any interaction or invalidation returns to full rate at once.
    const HOOK_IDLE_FPS = 30;
    let frameTimer = null;
    function invalidateThreeView(delayMs) {
        sceneVisualRevision++;
        queueThreeFrame(delayMs);
    }
    // A frame that must redraw the view: the camera moved or something asked for a redraw.
    function queueThreeFrame(delayMs) {
        renderInvalidated = true;
        scheduleThreeFrame(delayMs);
    }
    // The loop's own next step while hooks animate: nothing asked for a redraw, so the frame keeps
    // the shadow map. Keeping this apart from queueThreeFrame is what makes hooks-only frames cheap;
    // when the loop rescheduled itself through queueThreeFrame, every frame counted as invalidated.
    function scheduleThreeFrame(delayMs) {
        if (!isActive || !loopRunning || document.hidden || frameId) return;
        if (frameTimer) {
            if (delayMs > 0) return; // a paced frame is already on its way
            clearTimeout(frameTimer);
            frameTimer = null;
        }
        if (delayMs > 0) {
            frameTimer = setTimeout(() => {
                frameTimer = null;
                if (isActive && loopRunning && !document.hidden && !frameId) frameId = requestAnimationFrame(renderFrame);
            }, delayMs);
        } else {
            frameId = requestAnimationFrame(renderFrame);
        }
    }
    function onCameraChange() {
        noteInput();
        queueThreeFrame();
    }
    // Why the loop is running (or not): the last frame's live hooks, camera motion and invalidation.
    // Read it from the console (window.__threeFrameDebug()) when an idle view keeps drawing frames.
    const lastFrameDebug = { live: new Set(), moving: false, wasInvalidated: false, at: 0 };
    window.__threeFrameDebug = () => ({
        hooks: frameHooks.map(hook => hook.name || 'anonymous'), live: [...lastFrameDebug.live],
        moving: lastFrameDebug.moving, wasInvalidated: lastFrameDebug.wasInvalidated, hooksParked,
        idleMs: Math.round(performance.now() - lastInputAt), autoRotate: !!controls?.autoRotate || manualAutoRotateActive,
        frameAgeMs: Math.round(performance.now() - lastFrameDebug.at), loopRunning, frameId: frameId !== null, frameTimer: !!frameTimer
    });
    // Input keeps the decorative hooks awake; once they have parked, the first input restarts the loop.
    function noteInput() {
        lastInputAt = performance.now();
        if (hooksParked) scheduleThreeFrame(0);
    }
    // `?fps=1`: a model-mode frame-time readout (photo mode has its own). It keeps the WORST frame of
    // each one-second window rather than the mean, because an isolated stall vanishes in an average.
    let perfReadout = null;
    const perfWindow = { start: 0, frames: 0, maxFrame: 0, maxHooks: 0, maxRender: 0, lastLog: 0 };
    function ensurePerfReadout() {
        let wanted = false;
        try { wanted = !!new URLSearchParams(window.location.search || '').get('fps'); } catch (_) { }
        if (!wanted || perfReadout || !threeContainer) return;
        perfReadout = document.createElement('div');
        perfReadout.className = 'photoreal-status three-perf-readout';
        threeContainer.appendChild(perfReadout);
    }
    function recordPerfFrame(now, t0, t1, t2) {
        const w = perfWindow;
        if (!w.start) w.start = now;
        w.frames++;
        w.maxFrame = Math.max(w.maxFrame, t2 - t0);
        w.maxHooks = Math.max(w.maxHooks, t1 - t0);
        w.maxRender = Math.max(w.maxRender, t2 - t1);
        if (now - w.start < 1000) return;
        const fps = Math.round(w.frames * 1000 / (now - w.start));
        const life = lifeLayer ? lifeLayer.stats() : null;
        const text = `${fps} fps · worst frame ${w.maxFrame.toFixed(1)} ms · hooks ${w.maxHooks.toFixed(1)} ms · render ${w.maxRender.toFixed(1)} ms`
            + ` · ${renderer ? renderer.info.render.calls : 0} draw calls`
            + (life && (life.vehicles || life.people)
                ? ` · life ${life.frameMs.toFixed(2)} ms (${life.vehicles} vehicles, ${life.people} people, ${life.drawCalls} draws)` : '');
        if (perfReadout) perfReadout.textContent = text;
        if (now - w.lastLog > 5000) { console.log('[3D perf] ' + text); w.lastLog = now; }
        w.start = now; w.frames = 0; w.maxFrame = 0; w.maxHooks = 0; w.maxRender = 0;
    }

    function renderFrame(now) {
        frameId = null;
        if (!isActive || !loopRunning || document.hidden) return;
        const wasInvalidated = renderInvalidated;
        renderInvalidated = false;
        lastFrameDebug.live.clear();
        const perfT0 = perfReadout ? performance.now() : 0;
        stepManualAutoRotate(now);
        const moving = controls ? controls.update() : false;
        if (camera) {
            const dist = controls?.target ? camera.position.distanceTo(controls.target) : camera.position.length();
            if (!lastPlaneDist || Math.abs(dist - lastPlaneDist) > lastPlaneDist * 0.15) {
                camera.near = Math.max(1, dist * 0.001);
                camera.far = Math.max(1000, dist * 10);
                camera.updateProjectionMatrix();
                lastPlaneDist = dist;
            }
        }
        // A hook returns false when it has nothing to animate right now (people parked after idle,
        // photo tiles settled); only live hooks keep the loop running. A live hook may answer with the
        // milliseconds until it next needs a frame (the sun between two steps); anything else means
        // every hook frame (HOOK_IDLE_FPS).
        let liveHooks = 0;
        let hookDelayMs = Infinity;
        for (const hook of frameHooks) {
            try {
                const answer = hook(now);
                if (answer === false) continue;
                liveHooks++;
                lastFrameDebug.live.add(hook.name || 'anonymous');
                hookDelayMs = Math.min(hookDelayMs, typeof answer === 'number' && answer >= 0 ? answer : 0);
            } catch (error) { console.error('[3D] frame hook failed', error); }
        }
        hooksParked = frameHooks.length > 0 && liveHooks === 0;
        lastFrameDebug.moving = moving; lastFrameDebug.wasInvalidated = wasInvalidated; lastFrameDebug.at = now;
        const perfT1 = perfReadout ? performance.now() : 0;
        // Frames that only advance the life layer reuse the last shadow map.
        drawFrame(wasInvalidated || renderInvalidated || moving || !!controls?.autoRotate
            || manualAutoRotateActive || liveHooks === 0);
        if (retiredGroups.length) releaseRetiredGroups();
        if (perfReadout) recordPerfFrame(now, perfT0, perfT1, performance.now());
        const hooksOnly = !renderInvalidated && !moving && !controls?.autoRotate && !manualAutoRotateActive && liveHooks > 0;
        if (renderInvalidated || moving || controls?.autoRotate || manualAutoRotateActive || liveHooks) {
            scheduleThreeFrame(hooksOnly ? Math.max(Math.round(1000 / HOOK_IDLE_FPS) - 4, hookDelayMs) : 0);
        }
    }
    function startLoop() {
        cancelLoop();
        loopRunning = true;
        lastInputAt = performance.now();
        sceneReady = true;
        resolveSceneReady?.(true);
        resolveSceneReady = null;
        window.ThreeCompare?.attach?.({ container: threeContainer, invalidate: invalidateThreeView, compareChanged: refreshCompareUnapplied3D });
        // We are ready: hide overlay and settle the mode buttons.
        hideRenderingOverlay();
        isTransitioning3D = false;
        updateModeButtonStates();
        // Signal readiness so callers that entered 3D just to stack another mode on top
        // (e.g. realistic-from-2D) can proceed once the abstract scene is actually up.
        try { window.dispatchEvent(new Event('threeModeReady')); } catch (_) { }
        console.log('[3D] startLoop() called, pendingIntroAutoRotate:', pendingIntroAutoRotate);
        // Keep the Google view still while tiles refine and the terrain establishes its height.
        if (window.__mapModeState?.desired !== 'photo') startPendingIntroAutoRotate();
        lastPlaneDist = 0;
        invalidateThreeView();
    }

    function startPendingIntroAutoRotate() {
        if (!pendingIntroAutoRotate) return;
        pendingIntroAutoRotate = false;
        if (!window.__reducedMotion) startIntroAutoRotate();
    }

    function cancelLoop() {
        loopRunning = false;
        if (frameId) {
            try { cancelAnimationFrame(frameId); } catch (_) { }
            frameId = null;
        }
        if (frameTimer) {
            clearTimeout(frameTimer);
            frameTimer = null;
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
        invalidateThreeView();
        // Do not reframe here: camera + controls.target are the user's current pan/orbit state.
        // Updating only the projection keeps that state intact across layout and window resizes.
    }

    function disposeScene() {
        releaseRetiredGroups();
        lampGlowObjects.clear();
        sky = null;   // its dome and stars go with the scene below
        clearTimeout(warmSceneTimer);
        warmSceneTimer = null;
        warmSceneKey = null;
        stopSceneWork();
        sceneReady = false;
        resolveSceneReady?.(false);
        resolveSceneReady = null;
        sceneReadyPromise = null;
        resizeObserver?.disconnect();
        resizeObserver = null;
        cancelLoop();
        disposeFloorPlans();
        // Full scene eviction releases every attached resource. Source caches release separately.
        threeResources.disposeSharedSubtree(scene);
        window.__threeModeDisposeBuildingGeometryCache?.();
        window.__threeModeDisposeGltfCache?.();
        stopIntroAutoRotate();
        corridorTerrainSampler = null;
        corridorTerrainReferenceGeneration += 1;
        disposeTerrainCorridorGroup();
        disposeLife();
        disposeGround();
        perfReadout = null;
        hideRenderingOverlay();
        isTransitioning3D = false;
        if (controls && controls.dispose) {
            try { controls.dispose(); } catch (_) { }
        }
        controls = null;
        // Tear down 3D selection pointer listeners and reset state.
        if (renderer && renderer.domElement) {
            if (parcelClickHandler) { try { renderer.domElement.removeEventListener('click', parcelClickHandler); } catch (_) { } }
            if (parcelPointerDownHandler) { try { renderer.domElement.removeEventListener('pointerdown', parcelPointerDownHandler); } catch (_) { } }
            if (inputHandler) {
                try { renderer.domElement.removeEventListener('pointermove', inputHandler); } catch (_) { }
                try { renderer.domElement.removeEventListener('wheel', inputHandler); } catch (_) { }
            }
        }
        inputHandler = null;
        parcelClickHandler = null;
        parcelPointerDownHandler = null;
        if (proposalSelectionUnsubscribe) {
            try { proposalSelectionUnsubscribe(); } catch (_) { }
            proposalSelectionUnsubscribe = null;
        }
        clickDownXY = null;
        // The stack closes with the scene and sends a hosted Buildings and massing panel home.
        try { window.ThreeClickStack?.close({ silent: true }); } catch (_) { }
        isolatedParcelId = null;
        isolatedProposalId = null;
        isolationResetEl = null;
        isolationBannerEl = null;
        parcelInfoPanelEl = null;
        facadeCheckbox = null;
        facadeStyleSelect = null;
        facadeNote = null;
        xrayButton = null;
        xrayNote = null;
        floorCutawayControl = null;
        floorCutawaySelect = null;
        sunLayer?.detach();
        sunLayer = null;
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
        waterGroup = null;
        greenGroup = null;
        treesGroup = null;
        existingTransitAlignmentGroup = null;
        sceneParcelSnapshot = [];
        nearbyWaterKey = null;
        nearbyGreenKey = null;
        flatGroup = null;
        corridorGroup = null;
        terrainCorridorGroup = null;
        corridorTerrainProfiles = [];
        plannedFlatGroup = null;
        parkGroundGroup = squareGroundGroup = lakeGroundGroup = proposalGroundGroup = parcelLayoutGroup = null;
        buildingGroup = null;
        existingBuildingsGroup = proposedBuildingsGroup = ineligibleBuildingsGroup = null;
        planningSourcesGroup = null;
        buildingDisplaySnapshot = null;
        buildingBuildPending = false;
        buildingWorkIncomplete = false;
        floorPlanGroup = null;
        parkGroup = null;
        squareGroup = null;
        lakeGroup = null;
        stationGroup = null;
        proposalInteractionGroup = null;
        proposalDraftGroup = null;
        buildingModeControlsEl?.remove();
        buildingRadiusPreview = null;
        stopBuildingRadiusPreview = null;
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

    function closeAllPanelsAndModalsFor3D() {
        // The 2D parcel panel's owner closes it (the Leaflet Parcel Info panel would otherwise stay
        // visible over 3D); the 3D view's own click stack starts closed.
        try {
            const hideLeafletParcelInfo = window.Parcels?.uiParcelPanel?.hideParcelInfoPanel
                || window.hideParcelInfoPanel;
            if (typeof hideLeafletParcelInfo === 'function') hideLeafletParcelInfo({
                preserveProposalSelection: window.PlanningViews?.getSelected()?.role === 'proposed'
            });
        } catch (_) { }
        try { window.ThreeClickStack?.close({ silent: true }); } catch (_) { }
        try { typeof hideProposalDetailsPanel === 'function' && hideProposalDetailsPanel(); } catch (_) { }
        try { typeof hideBlockInfo === 'function' && hideBlockInfo(); } catch (_) { }
        try { typeof hideRoadInfoPanel === 'function' && hideRoadInfoPanel(); } catch (_) { }
        try { typeof hideRoadAnalysisPanel === 'function' && hideRoadAnalysisPanel(); } catch (_) { }
        try { typeof hideOSMRoadSegmentListPopup === 'function' && hideOSMRoadSegmentListPopup(); } catch (_) { }
        try { typeof hideBlocksList === 'function' && hideBlocksList(); } catch (_) { }
        // The proposal form is suspended underneath the active on-map editor. Closing it
        // here would clear the parcel context that the editor is preparing for Done.
        let onMapEditorActive = false;
        try { onMapEditorActive = window.OnMapEditor?.isActive?.() === true; } catch (_) { }
        try { !onMapEditorActive && typeof closeProposalDialog === 'function' && closeProposalDialog(); } catch (_) { }
        try {
            const blockifyModal = document.getElementById('blockify-modal');
            if (!onMapEditorActive && blockifyModal && typeof closeBlockifyModal === 'function') closeBlockifyModal();
        } catch (_) { }
        // Close share modals (e.g., shared proposal inspector/summary) so they don't block 3D controls.
        // They are CbDialogs (js/proposals/dialog-share.js): their header close-circle-btn is the
        // dialog's own close.
        try {
            document.querySelectorAll('.share-modal-overlay .share-modal > .cb-dialog__header .close-circle-btn').forEach(btn => {
                try { btn.click(); } catch (_) { }
            });
        } catch (_) { }
        // Ensure built-in static modals are hidden: they show and hide with the hidden attribute,
        // through their own helpers (user-management.js), never an inline display.
        try { window.hideWelcomeModal?.(); } catch (_) { }
        try { window.hideLogoutModal?.(); } catch (_) { }
    }

    // How to tilt the camera is the one control nothing on screen advertises: left-drag pans, and
    // rotating needs Ctrl/Cmd (or the right button) — see three-snapshot-navigation.js, which flips
    // OrbitControls' LEFT button between PAN and ROTATE while the modifier is held. So it is
    // offered, once, a little after arriving: long enough not to land in the middle of the entry
    // animation, and gone again before it becomes furniture.
    const VIEW_ANGLE_HINT_DELAY_MS = 10000;
    const VIEW_ANGLE_HINT_VISIBLE_MS = 6000;
    let viewAngleHintTimer = null;
    let viewAngleHintHideTimer = null;
    const viewAngleHintShown = { model: false, photo: false };

    function hideViewAngleHint() {
        const el = document.querySelector('.three-view-hint');
        if (el && el.parentNode) el.parentNode.removeChild(el);
        if (viewAngleHintHideTimer) { clearTimeout(viewAngleHintHideTimer); viewAngleHintHideTimer = null; }
    }

    function cancelViewAngleHint() {
        if (viewAngleHintTimer) { clearTimeout(viewAngleHintTimer); viewAngleHintTimer = null; }
        hideViewAngleHint();
    }

    // `mode` is 'model' or 'photo' — shown once for each, so arriving in photo view by way of the
    // model does not say it twice, and a user who only ever uses one still gets told.
    function scheduleViewAngleHint(mode) {
        const key = mode === 'photo' ? 'photo' : 'model';
        if (viewAngleHintShown[key]) return;
        if (viewAngleHintTimer) clearTimeout(viewAngleHintTimer);
        viewAngleHintTimer = setTimeout(() => {
            viewAngleHintTimer = null;
            const host = document.getElementById('three-container');
            const feedbackStack = document.getElementById('map-feedback-stack');
            // Gone from 3D while the timer ran: say nothing.
            if (!host || !feedbackStack || !isActive) return;
            viewAngleHintShown[key] = true;
            hideViewAngleHint();
            const el = document.createElement('div');
            el.className = 'three-view-hint';
            el.setAttribute('role', 'status');
            // Touch: one finger pans, two fingers are DOLLY_ROTATE (three-snapshot-navigation.js),
            // so moving two fingers together tilts/turns the view — there is no Ctrl to press.
            const coarsePointer = typeof window.matchMedia === 'function'
                && window.matchMedia('(pointer: coarse)').matches;
            el.textContent = coarsePointer
                ? threeI18n('threeMode.hints.viewAngleTouch', 'Drag with two fingers to change the view angle')
                : threeI18n('threeMode.hints.viewAngle', 'Press Ctrl (or Cmd) and drag to change the view angle');
            const status = document.getElementById('floating-status');
            if (status && status.parentNode === feedbackStack) feedbackStack.insertBefore(el, status);
            else feedbackStack.appendChild(el);
            viewAngleHintHideTimer = setTimeout(hideViewAngleHint, VIEW_ANGLE_HINT_VISIBLE_MS);
        }, VIEW_ANGLE_HINT_DELAY_MS);
    }

    async function enter3D(options = {}) {
        if (isActive) {
            // Already up. A request that names proposals (a link, the activity feed, a list) frames
            // them in place, or rebuilds the scene around them when their ground is not loaded.
            const focus = Array.isArray(options.focusProposalIds) ? options.focusProposalIds.filter(id => id != null).map(String) : [];
            if (!focus.length || frameProposalsInScene(focus) !== 'relocate') return sceneReadyPromise || sceneReady;
            // The scene was built around other ground: leave it, let the 2D map go to the proposals
            // and load their parcels, then build the scene again around them below.
            exit3D();
            showRenderingOverlay();
            await settleGroundForProposals(focus);
            if (isActive) return sceneReadyPromise || sceneReady;
        }
        clearTimeout(warmSceneTimer);
        warmSceneTimer = null;
        const reuse = sceneReady && scene && warmSceneKey === currentSceneKey()
            && !options.focusProposalIds && !options.restoreView;
        warmSceneKey = null;
        isActive = true;
        scheduleViewAngleHint('model');
        // 3D takes the full stage: fold away an open sheet so the canvas and its in-view controls
        // get the whole viewport.
        if (window.MapShell) window.MapShell.closeSheets();
        // Optional focus: frame only these proposals (by proposalId) instead of all applied ones.
        // Used by shared-link entry so the camera lands on the just-loaded proposal.
        focusProposalIds = (options && Array.isArray(options.focusProposalIds) && options.focusProposalIds.length)
            ? new Set(options.focusProposalIds.map(String))
            : null;
        console.log('[3D] enter3D focus ids:', focusProposalIds ? focusProposalIds.size : 0,
            focusProposalIds ? Array.from(focusProposalIds).slice(0, 4) : '(none — framing all applied)');
        stopIntroAutoRotate();
        pendingIntroAutoRotate = options.fromUrl === true && options.rotate === true && !window.__reducedMotion;
        // A saved pose sets the starting view and its orbit target. Rotation is an explicit choice.
        pendingRestoreView = (options && options.restoreView) ? options.restoreView : null;
        if (pendingIntroAutoRotate) {
            watchIntroAutoRotateStop();
            console.log('[3D] URL-driven entry detected, will start auto-rotate after tilt animation');
        }
        try { document.body.classList.add('three-mode-active'); } catch (_) { }
        if (threeContainer) {
            threeContainer.classList.add('active');
            // Hidden from assistive tech only while 3D is off; its panels and buttons are real UI when on.
            threeContainer.removeAttribute('aria-hidden');
        }
        updateModeButtonStates();
        // Only show the walk launcher for cities that configure a walk overlay (e.g. Zagreb).
        if (walkBtn) walkBtn.hidden = !getWalkUrlBase();
        // The AI button's visibility and enabled state are owned by updateModeButtonStates().

        showRenderingOverlay();
        disableLeafletInteractions();
        closeAllPanelsAndModalsFor3D();
        window.MapShell?.syncModeAvailability();
        if (reuse) {
            sceneAbort = new AbortController();
            const signal = sceneAbort.signal;
            handleResize();
            if (controls) controls.enabled = true;
            if (buildingWorkIncomplete) {
                buildingWorkIncomplete = false;
                buildingViewDirty = false;
                await rebuild3DBuildingsOnly();
            } else if (buildingViewDirty) {
                buildingViewDirty = false;
                if (!applyRetainedBuildingDisplay()) await rebuild3DBuildingsOnly();
            }
            if (!isActive || signal.aborted) return false;
            startLoop();
            ensureNearbyProposalBuildings();
            ensureNearbyTrees();
            ensureNearbyWater();
            ensureNearbyGreen();
        } else if (!await initScene()) return false;
        // initScene/reuse already applied the building policy. A late context refresh may still
        // be pending here; re-syncing it would enqueue another full proposal rebuild.
        applyModeVisibility();
        rebuildPlanningSources3D();
        if (window.activeProposalDraftComparison?.draftId && typeof window.renderProposalDraftComparison === 'function') {
            window.renderProposalDraftComparison(
                window.activeProposalDraftComparison.draftId,
                window.activeProposalDraftComparison.mode || 'overlay'
            );
        }
        // A reload for a new release reopens the person's own stack instead (app-updates.js).
        const resuming = !!window.UpdateResume?.pending();
        const selectedDesign = resuming ? null : window.ProposalSelection?.getKey?.();
        const focusedDesign = !resuming && focusProposalIds?.size ? [...focusProposalIds][0] : null;
        if (focusedDesign || selectedDesign) {
            // An exact shared camera describes the whole map, not an isolated view of its first
            // design. Keep the selected section and outline without filtering or reframing it.
            showThreeModeDesign(focusedDesign || selectedDesign, null, { preserveView: !!options.restoreView });
        }
        return true;
    }

    function exit3D() {
        stopBuildingRadiusPreview?.();
        try { document.body.classList.remove('three-mode-active'); } catch (_) { }
        cancelViewAngleHint(); // never let it land on the 2D map after the user has left
        if (!isActive) return;
        // Capture this before disposing the local scene frame. The Leaflet map intentionally stays
        // motionless while 3D is active (so it cannot stream tiles or parcels), then jumps once to
        // the current 3D focus when the user explicitly returns to 2D.
        const exitMapCenter = snapshotNavigation.resolveExitMapCenter(
            controls && controls.target,
            xyToLatLng
        );
        isActive = false;
        window.ThreeCompare?.detach?.();
        compareSplit = null;
        compareUnappliedKey = null;
        clearGroupChildren(compareUnappliedGroup);
        // The click stack is the 3D view's; the 2D map has its own.
        try { window.ThreeClickStack?.close({ silent: true }); } catch (_) { }
        focusProposalIds = null; // reset shared-link focus; a manual re-entry frames all proposals
        stopIntroAutoRotate();
        cancelWalkPick();
        if (walkBtn) walkBtn.hidden = true;
        // (AI button state: updateModeButtonStates.)
        if (threeContainer) {
            threeContainer.classList.remove('active');
            threeContainer.setAttribute('aria-hidden', 'true');
        }
        // Defensive: if we exit before startLoop ran (aborted entry), the "Rendering…" overlay
        // and the transition guard would otherwise leak and jam future entries.
        isTransitioning3D = false;
        hideRenderingOverlay();
        updateModeButtonStates();
        enableLeafletInteractions();
        window.MapShell?.syncModeAvailability();
        cancelLoop();
        stopSceneWork();
        pendingModelLoads = 0;
        updateBuildingsLoader();
        if (controls) controls.enabled = false;
        const retain = sceneReady && threeResources.measureSceneBytes(scene).total <= WARM_SCENE_MAX_BYTES;
        if (!retain) disposeScene();
        if (exitMapCenter && typeof map !== 'undefined' && map && typeof map.setView === 'function') {
            try {
                const zoom = (typeof map.getZoom === 'function') ? map.getZoom() : undefined;
                map.setView([exitMapCenter.lat, exitMapCenter.lng], zoom, { animate: false });
            } catch (_) { }
        }
        if (retain) {
            warmSceneKey = currentSceneKey();
            warmSceneTimer = setTimeout(() => { if (!isActive) disposeScene(); }, WARM_SCENE_TTL_MS);
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
    for (const event of ['parcelFabricCommitted', 'buildingsLayerUpdated', 'proposedBuildingsUpdated', 'parksUpdated', 'squaresUpdated', 'lakesUpdated', 'stationsUpdated', 'buildingGroundsUpdated']) {
        window.addEventListener(event, () => { sceneRevision++; });
    }

    window.addEventListener('parcelFabricCommitted', rebuildTreesOnly);

    window.addEventListener('buildingsLayerUpdated', () => {
        if (!isActive) return;
        rebuild3DBuildingsOnly({ family: 'existing' });
        refreshLifeSurface();
    });

    window.addEventListener('planninggeometrychange', rebuildPlanningSources3D);
    window.addEventListener('planningselectionchange', () => {
        // An outside inspector selection ends the click's view; the stack's own section switches
        // select there too and are not an outside choice.
        if (isActive && !stackDriving) endSelectionView();
        rebuildPlanningSources3D();
    });
    window.addEventListener('planningviewchange', syncPlanningView3D);

    // Rebuild on proposed buildings updates. Invalidate the nearby cache too so the
    // buffer query re-runs against the new proposal shape.
    window.addEventListener('proposedBuildingsUpdated', () => {
        nearbyProposalBuildingsKey = null;
        if (!isActive) return;
        rebuild3DBuildingsOnly();
        rebuildProposalInteraction3D();
        refreshLifeSurface();
    });

    // Rebuild parks/squares/lakes/stations when their 2D state changes. The "flat" portion of each
    // (grounds, paths, water) lives in plannedFlatGroup; the "deco" portion (trees,
    // fountains, fish) lives in its own group. Both clear together so the legacy
    // userData.isParkGround/isSquareGround/isLakeShore filtering on flatGroup is no longer
    // needed.
    function refreshStructures3D() {
        const eventName = arguments[0]?.type || null;
        structureRefresh.refreshStructureScene3D({
            isActive: () => isActive,
            hasScene: () => !!scene,
            initScene,
            groups: [parkGroundGroup, squareGroundGroup, lakeGroundGroup, proposalGroundGroup, parcelLayoutGroup, parkGroup, squareGroup, lakeGroup, stationGroup],
            parcelLayoutGroup,
            clearGroup: clearGroupChildren,
            rebuildParcelGround: rebuildParcelGround3D,
            layers: {
                parks: { groups: [parkGroundGroup, parkGroup], build: () => buildParks3D(parkGroundGroup, parkGroup) },
                squares: { groups: [squareGroundGroup, squareGroup], build: () => buildSquares3D(squareGroundGroup, squareGroup) },
                lakes: { groups: [lakeGroundGroup, lakeGroup], rebuildParcelGround: true, build: () => buildLakes3D(lakeGroundGroup, lakeGroup) },
                stations: { groups: [stationGroup], rebuildParcelGround: true, build: () => buildTransitStations3D(stationGroup) },
                buildingGrounds: { groups: [proposalGroundGroup], build: () => buildProposalGrounds3D(proposalGroundGroup) }
            },
            buildParcelLayouts: () => rebuildPlannedParcelLayout3D(),
            applyDisplay: applyModeVisibility,
            rebuildBuildings: rebuild3DBuildingsOnly,
            rebuildInteraction: rebuildProposalInteraction3D,
            onError: (label, error) => console.error(`[three-mode] Failed to rebuild ${label} in 3D`, error)
        }, eventName);
        // Parks and plazas are where people wander, so the population follows a structure change.
        try { rebuildLifeOnly(); } catch (error) { console.warn('[3D life] rebuild after structures failed', error); }
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

    // --- Walk-through (zagreb.lol/voznja) launcher ---
    // The user clicks the walk button while in 3D, then clicks a point on the ground;
    // we open zagreb.lol/voznja in a new tab with that lat/lng plus the CIDs of the
    // currently-applied published designs, which voznja reads from the index (GET /designs/:cid),
    // so it loads exactly the same scene the user is looking at.
    function publishedDesignCid(proposal) {
        return proposal ? window.DesignSync.publishedCid(proposal) : null;
    }

    function getAppliedProposals() {
        try {
            const storage = (typeof window !== 'undefined') ? window.proposalStorage : null;
            if (!storage || typeof storage.getAllProposals !== 'function') return [];
            return storage.getAllProposals().filter(p => {
                if (!p) return false;
                if (isApplied(p)) return true;
                return ['roadProposal', 'buildingProposal', 'structureProposal', 'parcelLayout']
                    .some(key => p[key] && isApplied(p, p[key]));
            });
        } catch (e) {
            console.warn('[walk] failed to enumerate applied proposals:', e);
            return [];
        }
    }

    function getAppliedDesignCids() {
        // Sorted and de-duplicated, the order of a /designs/<cids> link.
        return window.DesignSync.sortedCids(getAppliedProposals().map(publishedDesignCid).filter(Boolean));
    }

    // The applied designs the walk still waits for: unpublished ones that can be published. One that
    // cannot (ProposalPublishTerms.publishRefusal: invalid or too large) does not hold the walk up.
    function getNonUploadedAppliedProposals() {
        return getAppliedProposals().filter(p => !publishedDesignCid(p) && !window.ProposalPublishTerms.publishRefusal(p));
    }

    function buildWalkUrl(lat, lng) {
        // Param shape per zagreb-isochrone-main/website/station-3d/modes/cab.js
        // (buildWalkShareUrl): st3d=walk, lat, lon (NOT lng), heading, pitch, proposals.
        const ids = getAppliedDesignCids();
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
        return window.__threeClickPlan.subjectHit(raycaster.intersectObjects(targets, true));
    }

    // Google tiles identify a visible surface point; source footprints give that point a building
    // identity. Hidden abstract meshes never act as stand-ins for the Google city.
    function photoScenePick(evt) {
        const photo = window.PhotorealMode;
        const surface = photo.pickSurface(evt);
        const authored = pickMapSubjectFromEvent(evt);
        const sourcePoint = surface?.point || authored?.point;
        if (!sourcePoint) return { picked: null, groundParcelId: null, hits: null };
        const recordsAt = point => {
            const latlng = xyToLatLng(point.x, point.y);
            const hits = window.ClickStackHits.hitsAt(latlng);
            const location = turf.point([latlng.lng, latlng.lat]);
            const built = observedBuildingFeatures().filter(feature => turf.booleanPointInPolygon(location, feature))
                .map(feature => ({ id: clickedBuildingId(feature), feature }));
            hits.built = [...built, ...hits.built];
            const source = photo.sourceParcelsAt(point).map(parcel => ({ id: parcel.id,
                feature: parcel.feature, label: window.ThreeClickStack.parcelLabel(parcel.id), live: false }));
            return window.ClickStackHits.withSourceParcels(hits, source);
        };
        let records = recordsAt(sourcePoint);
        const hit = window.__threeClickPlan.photoHit({ authored, surface, designs: records.hits.designs, built: records.hits.built });
        if (hit?.point && hit.point !== sourcePoint) records = recordsAt(hit.point);
        return { picked: hit?.picked || null, groundParcelId: records.groundParcelId, hits: records.hits };
    }

    function handleParcelClick(evt) {
        if (evt.button !== 0) return;
        // An on-map editor owns map clicks while its edit lock is held. OrbitControls remain
        // untouched, so users can still rotate and pan the 3D view around the live design.
        if (mapSelectionBlockedByEditor()) { clickDownXY = null; return; }
        if (suppressClickAfterRotateStop) { suppressClickAfterRotateStop = false; return; }
        // Walk-pick owns clicks while it's active.
        if (walkPickActive) return;
        // Ignore the click that ends a camera drag (orbit/tilt) — only a near-stationary
        // press-and-release should select.
        if (clickDownXY) {
            const moved = Math.hypot(evt.clientX - clickDownXY.x, evt.clientY - clickDownXY.y);
            clickDownXY = null;
            if (moved > 6) return;
        }
        const resolved = realisticLayerActive ? photoScenePick(evt)
            : { picked: pickMapSubjectFromEvent(evt)?.picked || null, groundParcelId: parcelUnderClick(evt) };
        const { picked, groundParcelId } = resolved;
        if (window.multiParcelSelection?.isActive) {
            const layer = groundParcelId && window.LiveParcelFabric?.get(groundParcelId) && window.ParcelPresenter?.getLayer(groundParcelId);
            if (layer) window.multiParcelSelection.toggleParcel(layer);
            return;
        }
        const proposal = picked?.proposalId ? (window.proposalStorage?.getProposal?.(picked.proposalId) || null) : null;
        const clickParcelId = proposal && picked.parcelId ? String(picked.parcelId) : groundParcelId || picked?.parcelId || null;
        const click = { key: window.__threeClickPlan.clickKey({ picked, groundParcelId,
            builtId: clickedBuildingId(picked?.builtFeature), proposalKnown: !!proposal }),
            parcelId: clickParcelId, point: { x: evt.clientX, y: evt.clientY },
            // The section the click means: a click always selects the topmost object under it.
            focus: proposal ? 'designs' : window.ThreeClickStack?.focusOf({ ...(picked && !picked.proposalId ? picked : {}),
                formed: !!groundParcelId && groundInstance(groundParcelId).kind === 'formed' }) };
        if (window.ThreeClickStack?.retainClick(click)) return;
        // Every click is also a parcel click (three-click-plan.js): the parcel under the point comes
        // into view, and what the ray hit keeps its own meaning on top.
        const plan = window.__threeClickPlan.planThreeClick({
            picked, groundParcelId, viewedParcelId, isolatedParcelId, isolatedProposalId, proposalKnown: !!proposal
        });
        if (plan.clearSelection) window.PlanningViews?.select(null);
        if (plan.proposal) {
            const parcelId = picked.parcelId || proposal?.cadastreParcelIds?.[0] || null;
            // The scene presents this selection; no separate 2D details panel is opened.
            window.selectAndHighlightProposal?.(plan.proposal.id, parcelId, false, false, true);
        }
        if (plan.parcel?.action === 'clear') { deselectScene(); return; }
        // A parcel's massing is opened from its section, not on every click.
        if (plan.parcel) viewParcel(plan.parcel.id);
        // A click on nothing closes the stack, as in 2D (it has no close button of its own).
        if (!plan.parcel && !plan.proposal && !plan.selectMassing && !plan.inspectBuilding) {
            if (window.ThreeClickStack?.isOpen?.()) deselectScene();
            return;
        }
        showClickStack(picked, plan, click, resolved.hits);
    }

    // The parcel under a click, through whatever stands on it: the ray against the parcel slabs alone.
    function parcelUnderClick(evt) {
        if (!renderer || !camera || !flatGroup) return null;
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(((evt.clientX - rect.left) / rect.width) * 2 - 1, -((evt.clientY - rect.top) / rect.height) * 2 + 1);
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, camera);
        const slabs = flatGroup.children.filter(o => o && o.isMesh && o.visible && o.userData?.isParcel && o.userData.parcelId);
        const hit = raycaster.intersectObjects(slabs, false)[0];
        return hit ? String(hit.object.userData.parcelId) : null;
    }

    // Capture-phase boundary: when 3D is active, its keyboard context gets first refusal and
    // document-level 2D shortcuts never see the event. Text fields and native control activation
    // still pass through; modifier combinations retain their browser/OS default without reaching
    // application-level 2D listeners.
    function handleThreeModeKeyboardContext(evt) {
        // This window capture handler can consume keys before document listeners see them.
        if (isActive) noteInput();
        if (pendingIntroAutoRotate || controls?.autoRotate || manualAutoRotateActive) stopIntroAutoRotate();
        const action = keyboardContext.classifyThreeModeKeydown({
            active: isActive,
            key: evt.key,
            ctrlKey: evt.ctrlKey,
            metaKey: evt.metaKey,
            altKey: evt.altKey,
            target: evt.target,
            walkPickActive,
            hasIsolation: isolatedParcelId !== null || isolatedProposalId !== null || viewedParcelId !== null
                || !!window.ThreeClickStack?.isOpen?.(),
            overlayOpen: !!(document.body.classList.contains('map-sheet-open')
                || (window.MapShell && typeof window.MapShell.isBlockingDialogOpen === 'function'
                    && window.MapShell.isBlockingDialogOpen()))
        });
        if (action === 'pass') return;
        if (action === 'cancel-walk') cancelWalkPick();
        else if (action === 'clear-isolation') deselectScene();
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
        if (walkBtn) walkBtn.setAttribute('aria-pressed', 'true');
        if (threeContainer) threeContainer.classList.add('three-mode-walk-pick');
        // The pick is a second step; only the cursor said so, and the button looked like it did
        // nothing. Say what to do next (cancelWalkPick takes the hint off the toast again).
        if (typeof window.updateStatus === 'function') window.updateStatus(walkPickHintText());

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

    function walkPickHintText() {
        const key = 'threeMode.walkPickHint';
        const text = window.i18n && typeof window.i18n.t === 'function' ? window.i18n.t(key) : null;
        return text && text !== key ? text : 'Click the ground where you want to start walking (Esc cancels).';
    }

    function cancelWalkPick() {
        if (!walkPickActive) return;
        walkPickActive = false;
        // A stale "click the ground" on the toast after the pick ended read as still picking.
        const toast = document.getElementById('floating-status-text');
        if (toast && toast.textContent === walkPickHintText()) toast.textContent = '';
        if (walkBtn) walkBtn.setAttribute('aria-pressed', 'false');
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

            // Some applied designs are not published, so the walk page can't load them. Open
            // the upload-gate modal; it auto-closes when the list is empty and then we drop
            // straight into the walk pick.
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

    // Inverse of getGeoCameraView: place the orbit camera to reproduce a shared geographic view.
    // Reconstructs the camera's ground position with turf.destination + latLngToXY, so it inherits
    // the exact projection used at capture time rather than any hand-rolled scene-axis math. Only
    // the vertical needs an explicit metres->scene conversion (the scene shares the horizontal
    // 1/cos(lat) Mercator stretch on Z). Returns false when it can't, so the caller can fall back
    // to the normal auto-framing.
    function applyGeoCameraView(view) {
        try {
            if (!view || !camera || !controls || !origin3857) return false;
            if (typeof turf === 'undefined' || !turf) return false;
            const { targetLat, targetLng, headingDeg = 0, pitchRad = 0, range } = view;
            if (![targetLat, targetLng, range].every(v => Number.isFinite(v))) return false;

            const tXY = latLngToXY(targetLat, targetLng);
            if (!tXY) return false;
            const cosLat = Math.max(1e-6, Math.cos(targetLat * Math.PI / 180));

            const elevation = -pitchRad;                             // angle above the horizon
            const horizM = Math.max(0, range * Math.cos(elevation)); // ground distance, true metres
            const vertM = range * Math.sin(elevation);               // camera height above target, true metres

            // Camera sits opposite the look direction: target->camera bearing = (camera->target) + 180.
            const camGround = turf.destination([targetLng, targetLat], horizM / 1000, headingDeg + 180, { units: 'kilometers' });
            const cg = camGround.geometry.coordinates;               // [lng, lat]
            const cXY = latLngToXY(cg[1], cg[0]);
            if (!cXY) return false;

            const targetVec = new THREE.Vector3(tXY[0], tXY[1], 0);
            camera.up.set(0, 0, 1);
            controls.target.copy(targetVec);
            camera.position.set(cXY[0], cXY[1], vertM / cosLat);
            camera.lookAt(targetVec);
            if (controls.update) controls.update();
            return true;
        } catch (_) { return false; }
    }
    window.applyThree3DGeoView = function (view) {
        if (!view || !isActive) return false;
        if (isTransitioning3D) {
            pendingRestoreView = view;
            pendingIntroAutoRotate = false;
            return true;
        }
        stopIntroAutoRotate();
        return applyGeoCameraView(view);
    };

    // Capture the current 3D scene as a PNG data URL, for the AI photorealistic render.
    // The renderer is created without preserveDrawingBuffer, so we force a fresh synchronous
    // render and read the drawing buffer in the same tick (before the browser swaps/clears it).
    // The canvas backing store is viewport x devicePixelRatio (capped at 2), so on any retina
    // display a capture is ~7.5 MP. As a lossless PNG that is 6-12 MB — megabytes the image models
    // discard anyway (they resample to roughly 1-1.5k on the long side), and enough to blow the
    // upload size limit. Downscale before sending: same result from the model, a fraction of the
    // bytes and the upload time.
    const AI_CAPTURE_MAX_DIM = 1536;
    function captureDownscaledDataURL(mimeType, quality) {
        const src = renderer.domElement;
        const scale = Math.min(1, AI_CAPTURE_MAX_DIM / Math.max(src.width, src.height));
        const w = Math.max(1, Math.round(src.width * scale));
        const h = Math.max(1, Math.round(src.height * scale));
        const off = document.createElement('canvas');
        off.width = w;
        off.height = h;
        const ctx = off.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        // JPEG has no alpha: paint an opaque base first so any transparent pixel becomes black
        // rather than an undefined colour.
        if (mimeType === 'image/jpeg') {
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, w, h);
        }
        ctx.drawImage(src, 0, 0, w, h);
        return off.toDataURL(mimeType, quality);
    }

    function captureSceneDataURL() {
        if (!isActive || !renderer || !scene || !camera) return null;
        if (!getSceneReadiness({ requireExisting: builtDisplay !== 'off' && !realisticLayerActive }).ready) return null;
        try {
            renderScene();
            // JPEG for the colour view — it is photographic, so this is ~10x smaller than PNG with
            // no difference the model can act on.
            return captureDownscaledDataURL('image/jpeg', 0.92);
        } catch (_) { return null; }
    }
    window.captureThreeSceneDataURL = captureSceneDataURL;

    function getSceneReadiness({ requireExisting = true } = {}) {
        return window.__threeSceneReadiness.evaluate({
            active: isActive && !!renderer && !!scene && !!camera,
            transitioning: isTransitioning3D,
            requireExisting,
            existingVisible: builtDisplay !== 'off' && !realisticLayerActive && existingBuildingsGroup?.visible === true,
            fetching: nearbyProposalBuildingsFetching,
            outcome: nearbyBuildingsOutcome,
            existingBuildings: nearbyProposalBuildings.length,
            existingBuilt: buildingDisplaySnapshot?.existingReady === true,
            existingDataCurrent: buildingDisplaySnapshot?.existingDataRevision === nearbyBuildingsRevision,
            existingBuildFailures: buildingDisplaySnapshot?.existingBuildFailures || 0,
            building: buildingBuildPending || buildingRefreshQueue.pending,
            incomplete: buildingWorkIncomplete,
            dirty: buildingViewDirty,
            pendingModels: pendingModelLoads,
            frameCurrent: !!buildingDisplaySnapshot && renderedBuildingDisplaySnapshot === buildingDisplaySnapshot
                && renderedSceneVisualRevision === sceneVisualRevision
        });
    }
    window.ThreeSceneReady = {
        getState: getSceneReadiness,
        wait: options => window.__threeSceneReadiness.wait(() => getSceneReadiness(options), options),
        async capture(options) {
            await window.ThreeSceneReady.wait(options);
            const image = captureSceneDataURL();
            if (!image) throw new Error('The 3D scene changed before capture.');
            return image;
        }
    };

    // Grayscale HEIGHT MAP of the scene for the AI render: every fragment is shaded by its world Z
    // (this scene is Z-up, buildings extrude along +Z), so black = ground and white = the tallest
    // point. This gives the image model an unambiguous height signal the flat grey massing can't —
    // low buildings read dark, tall ones read bright — so it stops guessing heights. Rendered via a
    // one-shot scene.overrideMaterial; onBeforeCompile keeps Three's chunks (incl. the renderer's
    // logarithmicDepthBuffer) so occlusion stays correct. Returns { image, maxHeightM }.
    function makeHeightMaterial(minZ, maxZ) {
        const mat = new THREE.MeshBasicMaterial();
        mat.onBeforeCompile = (shader) => {
            shader.uniforms.uMinZ = { value: minZ };
            shader.uniforms.uMaxZ = { value: maxZ };
            shader.vertexShader = 'varying float vWorldZ;\n' + shader.vertexShader.replace(
                '#include <begin_vertex>',
                '#include <begin_vertex>\n    vWorldZ = (modelMatrix * vec4(transformed, 1.0)).z;'
            );
            shader.fragmentShader = 'varying float vWorldZ;\nuniform float uMinZ;\nuniform float uMaxZ;\n' +
                shader.fragmentShader.replace(
                    '#include <dithering_fragment>',
                    '#include <dithering_fragment>\n    float _t = clamp((vWorldZ - uMinZ) / max(0.001, uMaxZ - uMinZ), 0.0, 1.0);\n    gl_FragColor = vec4(vec3(_t), 1.0);'
                );
        };
        return mat;
    }

    function captureHeightMapDataURL() {
        if (!isActive || !renderer || !scene || !camera) return null;
        // The sky leaves the scene for this draw: empty space must read as 0 m (black).
        const skyGroup = sky?.group.parent === scene ? sky.group : null;
        try {
            if (skyGroup) scene.remove(skyGroup);
            const box = new THREE.Box3().setFromObject(scene);
            if (!isFinite(box.max.z)) return null;
            const minZ = 0;                                          // ground plane
            const maxZ = Math.min(400, Math.max(10, box.max.z));     // clamp so a stray far mesh can't wash it out
            const prevOverride = scene.overrideMaterial;
            const prevBg = scene.background;
            scene.overrideMaterial = makeHeightMaterial(minZ, maxZ);
            scene.background = new THREE.Color(0x000000);            // empty space = 0 m = black
            renderScene();
            // PNG, not JPEG: this image encodes heights as grey levels, so lossy artifacts would
            // literally change the building heights the model reads off it. Still downscaled.
            const url = captureDownscaledDataURL('image/png');
            scene.overrideMaterial = prevOverride;
            scene.background = prevBg;
            if (skyGroup) scene.add(skyGroup);
            renderScene();                         // restore the normal view in the buffer
            return { image: url, maxHeightM: Math.round(maxZ) };
        } catch (_) { return null; } finally {
            if (skyGroup && !skyGroup.parent) scene.add(skyGroup);
        }
    }
    window.captureThreeHeightMapDataURL = captureHeightMapDataURL;

    // Lightweight scene semantics for building the AI caption. Kept minimal on purpose —
    // the screenshot already carries the geometry; this only adds what the pixels can't say.
    window.getThreeSceneSummary = function () {
        let cityLabel = null;
        try { cityLabel = window.CityConfigManager?.getCurrentCityConfig?.().label || null; } catch (_) { }
        return {
            cityLabel,
            isolatedProposal: isolatedProposalId !== null,
            parcelCount: lastParcelCount || 0
        };
    };

    // Expose globals for debugging/manual control
    // Realistic layer policy: while the photoreal mesh is the built world, the abstract built
    // representations (parcel/road slabs, existing buildings, existing rail, OSM trees) hide —
    // proposals, corridor cross-sections and planned structures stay, standing on the mesh.
    window.setRealisticLayerActive = function (on, options = {}) {
        realisticLayerActive = !!on;
        rebuildPlanningSources3D();
        if (flatGroup) flatGroup.visible = !realisticLayerActive;
        if (treesGroup) treesGroup.visible = treesEnabled && !realisticLayerActive;
        if (waterGroup) waterGroup.visible = waterEnabled && !realisticLayerActive;
        if (greenGroup) greenGroup.visible = greenEnabled && !realisticLayerActive;
        syncLifeVisibility();
        syncGroundVisibility();
        // Shared proposal controls remain available; flat context controls are model-only.
        window.MapShell?.syncModeAvailability();
        if (realisticLayerActive) {
            stopBuildingRadiusPreview?.();
            isolatedParcelId = null;
            isolatedProposalId = null;
            try { updateIsolationButton(); } catch (_) { }
        }
        if (options.exiting) buildingViewDirty = true;
        else if (isActive && !applyRetainedBuildingDisplay()) rebuild3DBuildingsOnly();
        if (realisticLayerActive) startPendingIntroAutoRotate();
        if (!options.exiting && window.ThreeClickStack?.isOpen?.()) window.ThreeClickStack.refresh();
        invalidateThreeView();
    };
    window.invalidateThreeView = invalidateThreeView;
    window.registerThreeModeFrameHook = function (fn) {
        if (typeof fn === 'function' && !frameHooks.includes(fn)) frameHooks.push(fn);
        invalidateThreeView();
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
            pickGroundLatLng: pickGroundLatLngFromEvent,
            originLatLng: function () { const ll = xyToLatLng(0, 0); return { lat: ll.lat, lng: ll.lng }; },
            groundStats: function () { return groundLayer ? groundLayer.stats() : null; }
        };
    };
    window.__threeModeDriver = { enter: enter3D, exit: exit3D };
    // Photo view arrives through its own activation, so it asks for the hint itself.
    window.scheduleViewAngleHint = scheduleViewAngleHint;
    window.isThreeModeActive = function () { return isActive; };
    window.focusThreeModeOnProposals = focusThreeModeOnProposals;
    window.inspectThreeModeFeatures = (features, { zoom = false } = {}) => {
        if (!isActive) return false;
        highlightStackObject('agreements', { id: 'agreement-inspection', features });
        if (zoom) frameIsolatedFeatures(features);
        return true;
    };
    // Moves the camera onto features without selecting anything (a list row's preview).
    window.frameThreeModeFeatures = features => { if (isActive) frameIsolatedFeatures(features); };
    window.showThreeModeDesign = showThreeModeDesign;
    window.showThreeModeParcel = showThreeModeParcel;
    window.showThreeModeBuilding = showThreeModeBuilding;
    window.showThreeModePlan = showThreeModePlan;
    window.getThree3DGeoView = getGeoCameraView;
    window.setThreeXrayEnabled = setXrayEnabled;
    window.setThreeFloorCutaway = setFloorCutaway;
    window.setThreeSuggestedLayoutsEnabled = setSuggestedPlansEnabled;
    window.setThreeSuggestedExistingEnabled = setSuggestedExistingEnabled;

    // Window capture runs before every document-level shortcut, including the few legacy handlers
    // that also use capture. This is the keyboard-context boundary between the 3D and 2D apps.
    window.addEventListener('keydown', handleThreeModeKeyboardContext, true);

    document.addEventListener('proposal-draft-preview-change', event => {
        rebuildProposalDraftPreview3D(event.detail || null);
    });

    document.addEventListener('on-map-editor-preview-change', handleOnMapEditorPreviewChange);

    document.addEventListener('mapshell:sheetclosed', event => {
        if (event.detail?.id === 'layers-sheet') stopBuildingRadiusPreview?.();
    });

    threeContainer?.addEventListener('input', invalidateThreeView);
    threeContainer?.addEventListener('click', invalidateThreeView);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) invalidateThreeView();
    });
    // Initial paint also honors the click that requested this lazy-loaded module.
    updateModeButtonStates();
})();
