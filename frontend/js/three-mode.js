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
    let frameId = null;
    let origin3857 = null; // Leaflet EPSG:3857 origin for local XY
    let focusProposalIds = null; // Set of proposalIds to frame on 3D entry (shared-link focus), or null for all
    let renderingOverlayEl = null; // transient overlay while 3D initializes
    let isTransitioning3D = false; // avoid double-activation
    let buildingsLoaderEl = null; // in-view "loading buildings" badge
    let pendingModelLoads = 0; // count of uploaded glTF models still downloading

    // URL-driven entry: optionally start a gentle camera rotation until the user interacts.
    const INTRO_AUTO_ROTATE_SPEED = 0.7; // OrbitControls: ~86s per revolution (1.0 ≈ 60s)
    const INTRO_MANUAL_AUTO_ROTATE_RAD_PER_SEC = 0.18; // fallback if OrbitControls is missing
    const ORIGIN = new THREE.Vector3(0, 0, 0);
    let pendingIntroAutoRotate = false;
    let introAutoRotateCleanup = null;
    let manualAutoRotateActive = false;
    let manualAutoRotateLastTs = 0;

    // Groups for layers
    let flatGroup = null; // existing parcels + existing roads (always part of "built")
    let plannedFlatGroup = null; // park/square/lake grounds, paths, ponds, water, etc.
    let buildingGroup = null; // buildings extrusion
    let parkGroup = null; // park decorations (trees)
    let squareGroup = null; // square decorations (fountains, stalls)
    let lakeGroup = null; // lake decorations (fish)
    let existingRailGroup = null; // elevated viaduct for existing rail lines (city-gated)
    let elevatedRailData = null;  // fetched once per session; keyed by the config url
    let elevatedRailDataUrl = null;
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
            const btn2d = document.getElementById('mode-2d-toggle');
            const btn3d = document.getElementById('mode-3d-toggle');
            const btnRw = document.getElementById('mode-realistic-toggle');
            if (btn2d) btn2d.classList.toggle('active', !isActive);
            if (btn3d) btn3d.classList.toggle('active', isActive && !rw);
            if (btnRw) btnRw.classList.toggle('active', rw);
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
    let walkPickKeyHandler = null;

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
        // Buildings an applied corridor demolishes stay reddish in both Built modes, but their
        // opacity must follow the selected mode: solid really is solid, transparent remains ghosted.
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

    // Building display: the built context and the planned proposals each render independently
    // as 'solid' (opaque), 'ghost' (transparent) or 'off' (hidden). Defaults make the proposal
    // pop against a translucent context.
    let builtDisplay = 'ghost';
    let plannedDisplay = 'solid';
    let buildingModeControlsEl = null;
    let displayStateButtons = { built: {}, planned: {} };
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
    let isolationKeyHandler = null;
    let proposalSelectionUnsubscribe = null;
    // Pointer-down position, used to tell a short click apart from an orbit/tilt drag.
    let clickDownXY = null;

    // Scale factor to control how close the camera is vs top-down fit distance.
    // 1.0 means the 3D camera sits at the natural distance to fit the current
    // 2D map viewport — i.e. switching to 3D preserves the user's 2D altitude
    // and just adds tilt, instead of reframing to a different scale.
    const CAMERA_DISTANCE_SCALE = 1.0;

    function updateDisplayStateButtons() {
        try {
            ['built', 'planned'].forEach((kind) => {
                const current = kind === 'built' ? builtDisplay : plannedDisplay;
                Object.entries(displayStateButtons[kind] || {}).forEach(([state, btn]) => {
                    if (!btn) return;
                    btn.classList.toggle('three-mode-segment--active', state === current);
                    btn.setAttribute('aria-pressed', state === current ? 'true' : 'false');
                });
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
        // Planned structures (park/square/lake grounds + their decorations) hide when planned
        // is off. Both the flat half (grounds, paths, water) and the deco half (trees,
        // fountains, fish) toggle together.
        const showPlanned = plannedDisplay !== 'off';
        if (plannedFlatGroup) plannedFlatGroup.visible = showPlanned;
        if (parkGroup) parkGroup.visible = showPlanned;
        if (squareGroup) squareGroup.visible = showPlanned;
        if (lakeGroup) lakeGroup.visible = showPlanned;
        applyParcelVisibilityForMode(derivedParcelVisibilityMode());
    }

    function setBuildingDisplay(kind, state) {
        if (state !== 'solid' && state !== 'ghost' && state !== 'off' && state !== 'surviving') return;
        if (state === 'surviving' && kind !== 'built') return; // only existing fabric can "survive"
        if (kind === 'built') {
            if (builtDisplay === state) return;
            builtDisplay = state;
        } else if (kind === 'planned') {
            if (plannedDisplay === state) return;
            plannedDisplay = state;
        } else {
            return;
        }
        updateDisplayStateButtons();
        // Changing display drops out of parcel isolation so the new state is shown in full.
        isolatedParcelId = null;
        updateIsolationButton();
        rebuild3DBuildingsOnly();
        applyModeVisibility();
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
        [plannedFlatGroup, parkGroup, squareGroup, lakeGroup, existingRailGroup].forEach(g => { if (g) g.visible = false; });
    }

    // Hide everything except the given parcel and the building footprint(s) on it.
    function isolateParcel(parcelId) {
        if (!parcelId) return;
        isolatedParcelId = parcelId;
        isolatedProposalId = null;
        updateIsolationButton();
        updateParcelInfoPanel(parcelId);
        const pf = getParcelFeatureById(parcelId);
        applyIsolationVisibility(new Set([String(parcelId)]), pf ? [pf] : []);
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
    }

    function updateIsolationButton() {
        try {
            if (isolationResetEl) isolationResetEl.style.display = (isolatedParcelId === null && isolatedProposalId === null) ? 'none' : '';
        } catch (_) { }
    }

    function ensureBuildingModeControls() {
        if (!threeContainer) return;
        if (buildingModeControlsEl && buildingModeControlsEl.parentElement === threeContainer) {
            updateDisplayStateButtons();
            return;
        }

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

        // Display-state rows: Built and Planned each pick solid / transparent / off.
        const makeDisplayRow = (kind, labelText) => {
            const row = document.createElement('div');
            row.className = 'three-mode-emphasis-row';
            const label = document.createElement('span');
            label.className = 'three-mode-emphasis-label';
            label.textContent = labelText;
            // Full explanation on hover — the row label is short but its meaning isn't obvious.
            label.title = threeI18n('threeMode.controls.' + kind + 'Tooltip', labelText);
            row.appendChild(label);
            const wrap = document.createElement('div');
            wrap.className = 'three-mode-segmented';
            // Tooltip per state: the segment labels truncate with an ellipsis on a narrow
            // panel, so the title carries the full name plus what the state actually does.
            const stateTooltips = {
                solid: threeI18n('threeMode.controls.stateSolidTooltip', 'Solid'),
                ghost: threeI18n('threeMode.controls.stateGhostTooltip', 'Transparent'),
                surviving: threeI18n('threeMode.controls.stateSurvivingTooltip', 'Surviving'),
                off: threeI18n('threeMode.controls.stateOffTooltip', 'Off')
            };
            const states = [
                ['solid', threeI18n('threeMode.controls.stateSolid', 'Solid')],
                ['ghost', threeI18n('threeMode.controls.stateGhost', 'Transparent')],
                ['off', threeI18n('threeMode.controls.stateOff', 'Off')]
            ];
            if (kind === 'built') {
                // "Surviving": solid existing fabric, but the buildings the plan demolishes are
                // NOT drawn at all — the after-the-plan ground truth.
                states.splice(2, 0, ['surviving', threeI18n('threeMode.controls.stateSurviving', 'Surviving')]);
            }
            states.forEach(([state, stateLabel]) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'three-mode-segment';
                btn.textContent = stateLabel;
                if (stateTooltips[state]) btn.title = stateTooltips[state];
                btn.addEventListener('click', () => setBuildingDisplay(kind, state));
                displayStateButtons[kind][state] = btn;
                wrap.appendChild(btn);
            });
            row.appendChild(wrap);
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
        updateDisplayStateButtons();
        updateIsolationButton();
    }

    // Centre of the proposal being viewed (midpoint of the proposed buildings' bbox),
    // or null when there is no building proposal in the scene.
    function getProposalCenterLatLng() {
        const geom = computeProposalQueryGeometry();
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

    // The geometry the scene should anchor, frame and load context around: the selected proposal, and
    // nothing when nothing is selected — which makes every consumer fall through to the camera-focus
    // path, so the built context loads around where the user actually is.
    function proposalFramingGeometry() {
        return isProposalFocusedEntry() ? computeProposalQueryGeometry() : null;
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

    // Build Squares (ground + simple fountain)
    function buildSquares3D(flatTarget, decoTarget) {
        const squares = (typeof window !== 'undefined' && Array.isArray(window.squares)) ? window.squares : [];
        if (!squares || squares.length === 0) return;

        const stoneMat = new THREE.MeshLambertMaterial({ color: 0xbdbdbd, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        const rimMat = new THREE.MeshLambertMaterial({ color: 0x9a9a9a });
        const waterMat = new THREE.MeshPhongMaterial({ color: 0x3a8ad3, specular: 0x1f4f7a, shininess: 60 });

        squares.forEach(sq => {
            try {
                if (!sq || !sq.geometry) return;
                // Ground slightly above base to avoid z-fighting
                const groundMeshes = polygonFeatureToMeshes(sq, stoneMat, 0.06, 0);
                groundMeshes.forEach(m => { m.userData.isSquareGround = true; flatTarget.add(m); });

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

    // Existing heavy-rail lines as an elevated viaduct (tram-sim look), for cities that ship
    // a rail3d GeoJSON (city-config). Data is fetched once per session; the mesh is culled to
    // the framed content so the whole national network never enters the scene.
    function buildExistingRail3D(targetScene) {
        const config = (typeof window.CityConfigManager?.getRail3dConfig === 'function')
            ? window.CityConfigManager.getRail3dConfig()
            : null;
        if (!config || !config.url || typeof window.buildElevatedRail3D !== 'function') return;

        const attach = data => {
            if (!isActive || !scene || scene !== targetScene) return; // scene changed mid-fetch
            const content = computeContentBoundsXY();
            const diagonal = Math.max(1, Math.hypot(content.width || 0, content.height || 0));
            const maxRadius = Math.min(7000, Math.max(2000, diagonal * 1.5));
            const group = window.buildElevatedRail3D(data, coordsToXY, { maxRadius });
            if (!group) return;
            existingRailGroup = group;
            existingRailGroup.visible = builtDisplay !== 'off' && isolatedParcelId === null && isolatedProposalId === null;
            targetScene.add(existingRailGroup);
        };

        if (elevatedRailData && elevatedRailDataUrl === config.url) {
            attach(elevatedRailData);
            return;
        }
        fetch(config.url)
            .then(response => {
                if (!response.ok) throw new Error(`rail3d source responded ${response.status}`);
                return response.json();
            })
            .then(data => {
                elevatedRailData = data;
                elevatedRailDataUrl = config.url;
                attach(data);
            })
            .catch(error => console.error('[three-mode] existing rail lines failed to load', error));
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

    // Union of applied lake footprints: parcel ground must not cover the recessed basin,
    // so parcels intersecting a lake are meshed with the lake cut out of them.
    function lakeFootprintFeatures() {
        const lakes = (typeof window !== 'undefined' && Array.isArray(window.lakes)) ? window.lakes : [];
        return lakes
            .filter(lake => lake && lake.geometry)
            .map(lake => ({ type: 'Feature', properties: {}, geometry: lake.geometry }));
    }

    function cutLakesOutOfFeature(feature, lakeFeatures) {
        if (!lakeFeatures.length || typeof turf === 'undefined') return feature;
        let current = feature;
        for (const lake of lakeFeatures) {
            try {
                if (!turf.booleanIntersects(current, lake)) continue;
                const remainder = turf.difference(current, lake);
                if (!remainder) return null; // parcel fully under water
                current = remainder;
            } catch (error) {
                console.error('[three-mode] lake cut failed for a parcel — ground may cover the basin', error);
            }
        }
        return current;
    }

    function buildParcels3D(targetGroup) {
        if (typeof parcelLayer === 'undefined' || !parcelLayer) return;
        const lakeFeatures = lakeFootprintFeatures();
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
            const groundFeature = cutLakesOutOfFeature(f, lakeFeatures);
            if (groundFeature) {
                const meshes = polygonFeatureToMeshes(groundFeature, fillMat, 0, 0);
                meshes.forEach(m => { tag(m); targetGroup.add(m); });
            }
            const borders = polygonFeatureToBorderLines(f, edgeMat, 0.5);
            borders.forEach(line => { tag(line); targetGroup.add(line); });
        });
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

    function corridorStripToFeature(polygon) {
        const ring = polygon.map(point => [point.lng, point.lat]);
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
        return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
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

    function addCorridorDecorations3D(targetGroup, decorations) {
        const treePoints = decorations.filter(item => item.kind === 'tree');
        const signs = decorations.filter(item => item.kind !== 'tree');
        signs.forEach(item => {
            const [x, y] = latLngToXY(item.lat, item.lng);
            const size = Math.max(1.2, Math.min(3, Number(item.stripWidth) * 0.85));
            const geometry = new THREE.PlaneGeometry(size, size);
            const mesh = new THREE.Mesh(geometry, corridorSymbolMaterial(item.kind));
            mesh.position.set(x, y, CORRIDOR_STRIP_Z + 0.18);
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
            dummy.position.set(x, y, CORRIDOR_STRIP_Z + 0.15 + trunkHeight / 2);
            dummy.scale.set(1, 1, trunkHeight);
            dummy.rotation.set(0, 0, 0);
            dummy.updateMatrix();
            trunks.setMatrixAt(index, dummy.matrix);
            dummy.position.set(x, y, CORRIDOR_STRIP_Z + 0.15 + trunkHeight + crownRadius * 0.65);
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

    function addCorridorJunctions3D(targetGroup, junctions) {
        const asphalt = corridorLaneMaterial('driving');
        const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
        junctions.forEach(junction => {
            (junction.surfacePolygons || []).forEach(polygon => {
                polygonFeatureToMeshes(corridorStripToFeature(polygon), asphalt, CORRIDOR_STRIP_Z + 0.16, 0)
                    .forEach(mesh => {
                        mesh.userData.isCorridorJunction = true;
                        targetGroup.add(mesh);
                    });
            });
            (junction.crosswalkPolygons || []).forEach(polygon => {
                polygonFeatureToMeshes(corridorStripToFeature(polygon), white, CORRIDOR_STRIP_Z + 0.17, 0)
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
    function pushCorridorMarkingQuad(positions, a, b, half) {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const length = Math.hypot(dx, dy);
        if (length < 1e-6) return;
        const nx = (-dy / length) * half;
        const ny = (dx / length) * half;
        const z = CORRIDOR_MARKING_Z;
        const ax = a[0], ay = a[1], bx = b[0], by = b[1];
        positions.push(
            ax + nx, ay + ny, z, bx + nx, by + ny, z, bx - nx, by - ny, z,
            ax + nx, ay + ny, z, bx - nx, by - ny, z, ax - nx, ay - ny, z
        );
    }

    // Lay one marking polyline (Leaflet LatLngs) as flat paint: a solid ribbon, or dashes when `dash`
    // ({ on, off } in metres) is given. Dashes restart at each vertex — fine for the near-straight road
    // segments these lines run along.
    function addCorridorMarkingPolyline(positions, line, half, dash) {
        if (!Array.isArray(line) || line.length < 2) return;
        const pts = line.map(point => latLngToXY(point.lat, point.lng));
        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i];
            const b = pts[i + 1];
            if (!dash) { pushCorridorMarkingQuad(positions, a, b, half); continue; }
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const length = Math.hypot(dx, dy);
            if (length < 1e-6) continue;
            const ux = dx / length;
            const uy = dy / length;
            for (let d = 0; d < length; d += dash.on + dash.off) {
                const end = Math.min(d + dash.on, length);
                pushCorridorMarkingQuad(positions,
                    [a[0] + ux * d, a[1] + uy * d], [a[0] + ux * end, a[1] + uy * end], half);
            }
        }
    }

    // Every white line of one corridor segment — lane separators (dashed, the solid-flow divide heavier)
    // and parking bays (solid edge + bay dividers) — batched into ONE opaque mesh, so a long road is a
    // single draw call rather than thousands of little ones.
    function addCorridorMarkings3D(targetGroup, entry) {
        try {
        const positions = [];
        const markings = (typeof buildCorridorLaneMarkings === 'function')
            ? buildCorridorLaneMarkings([entry.points], entry.profile) : [];
        markings.forEach(marking => {
            const isCenterline = marking.kind === 'centerline';
            const half = isCenterline ? 0.09 : 0.075;
            const dash = isCenterline ? { on: 3, off: 2.5 } : { on: 1.5, off: 2.5 };
            (marking.lines || []).forEach(line => addCorridorMarkingPolyline(positions, line, half, dash));
        });
        const bays = (typeof buildCorridorParkingBays === 'function')
            ? buildCorridorParkingBays([entry.points], entry.profile) : [];
        bays.forEach(bay => addCorridorMarkingPolyline(positions, bay.line, bay.kind === 'edge' ? 0.075 : 0.06, null));

        // Direction arrows arrive as convex rings; a fan from vertex 0 triangulates each into the same
        // flat white mesh as the lines.
        const arrows = (typeof buildCorridorDirectionArrows === 'function')
            ? buildCorridorDirectionArrows([entry.points], entry.profile) : [];
        arrows.forEach(ring => {
            const pts = ring.map(point => latLngToXY(point.lat, point.lng));
            for (let i = 1; i < pts.length - 1; i++) {
                positions.push(
                    pts[0][0], pts[0][1], CORRIDOR_MARKING_Z,
                    pts[i][0], pts[i][1], CORRIDOR_MARKING_Z,
                    pts[i + 1][0], pts[i + 1][1], CORRIDOR_MARKING_Z
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

    function addBuildingTunnelLiners3D(targetGroup, definition) {
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
            const assembly = new THREE.Group();
            assembly.position.set((x1 + x2) / 2, (y1 + y2) / 2, CORRIDOR_STRIP_Z + 0.05);
            assembly.rotation.z = Math.atan2(y2 - y1, x2 - x1);

            const addBox = (geometry, material, x, y, z) => {
                const mesh = new THREE.Mesh(geometry, material);
                mesh.position.set(x, y, z);
                mesh.userData.isBuildingTunnel = true;
                mesh.userData.tunnelId = tunnel.id || tunnel.edgeKey;
                assembly.add(mesh);
            };

            addBox(new THREE.BoxGeometry(length, thickness, clearHeight), linerMaterial,
                0, -clearWidth / 2, clearHeight / 2);
            addBox(new THREE.BoxGeometry(length, thickness, clearHeight), linerMaterial,
                0, clearWidth / 2, clearHeight / 2);
            addBox(new THREE.BoxGeometry(length, clearWidth, thickness), linerMaterial,
                0, 0, clearHeight);

            [-length / 2, length / 2].forEach(x => {
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

    function buildCorridorStrips3D(targetGroup) {
        if (typeof buildCorridorStrips !== 'function' || typeof isAppliedCorridorProposal !== 'function') return;
        if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') return;

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
            const entries = ((typeof corridorSegmentEntries === 'function') ? corridorSegmentEntries(definition) : [])
                .filter(entry => Array.isArray(entry.points) && entry.points.length >= 2)
                .map(entry => entry.profile ? entry : { ...entry, profile: fallbackProfile });
            const renderEntries = entries.length
                ? entries
                : centerline.map(points => ({ points, profile: fallbackProfile }));

            renderEntries.forEach(entry => {
                buildCorridorStrips([entry.points], entry.profile).forEach(strip => {
                    const lane = (typeof CORRIDOR_LANE_TYPES !== 'undefined' && CORRIDOR_LANE_TYPES[strip.type]) || {};
                    const kerb = Number(lane.height) || 0;
                    strip.polygons.forEach(polygon => {
                        // A flat strip whose outline crosses itself (a star, a loop, a hairpin) can't be
                        // earcut — the fill floods the whole enclosed area. Lay the SAME band as a per-edge
                        // ribbon instead. Clean strips (and all extruded ones) keep the mitred earcut ring.
                        if (kerb === 0 && corridorStripRingSelfIntersects(polygon)) {
                            addFlatStripRibbon3D(targetGroup, entry.points, strip.left, strip.right,
                                corridorRibbonMaterial(strip.type), strip.type);
                            return;
                        }
                        const meshes = polygonFeatureToMeshes(
                            corridorStripToFeature(polygon),
                            corridorLaneMaterial(strip.type),
                            CORRIDOR_STRIP_Z,
                            kerb
                        );
                        meshes.forEach(mesh => {
                            mesh.userData.isCorridorStrip = true;
                            mesh.userData.laneType = strip.type;
                            targetGroup.add(mesh);
                        });
                    });
                });
                const decorations = (typeof buildCorridorDecorations === 'function')
                    ? buildCorridorDecorations([entry.points], entry.profile) : [];
                addCorridorDecorations3D(targetGroup, decorations);
                addCorridorMarkings3D(targetGroup, entry);
            });
            // Junction patches sized per arm cover the seams where different widths meet.
            const junctions = (typeof buildCorridorJunctionTreatmentsForEntries === 'function')
                ? buildCorridorJunctionTreatmentsForEntries(renderEntries)
                : ((typeof buildCorridorJunctionTreatments === 'function')
                    ? buildCorridorJunctionTreatments(centerline, fallbackProfile) : []);
            addCorridorJunctions3D(targetGroup, junctions);
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
            addBuildingTunnelLiners3D(targetGroup, definition);
        });
    }

    function buildNearbyProposalBuildings3D(targetGroup, buildingMaterial, hideDemolished = false) {
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
                (typeof proposalStorage !== 'undefined' && proposalStorage.getAllProposals()) || []
            );
            // One response can contain the same source surface twice: within one object (usually
            // opposite winding) or across adjacent/duplicate object_ids. Share these sets across the
            // entire rebuild so only one copy reaches the depth buffer.
            const meshDedupeState = { seenFaceKeys: new Set(), seenTriangleKeys: new Set() };
            const demolishedMaterial = demolishedMaterialFor(buildingMaterial);
            // null → untouched; { remainder: null, demolished } → whole building razed;
            // { remainder, demolished } → partial: prisms for both parts. Both are raw geometries.
            const asFeature = (geometry) => (geometry ? { type: 'Feature', properties: {}, geometry } : null);
            if (Array.isArray(nearbyProposalBuildings) && nearbyProposalBuildings.length > 0) {
                nearbyProposalBuildings.forEach(bld => {
                    try {
                        const carve = window.carveBuildingByObjectId(bld.object_id, carveRecords);
                        if (!carve) {
                            const mesh = buildMeshFromBuilding3D(bld, buildingMaterial, meshDedupeState);
                            if (mesh) targetGroup.add(mesh);
                            return;
                        }
                        if (carve.remainder) {
                            // PARTIAL demolition: the real mesh cannot be sliced, so the affected
                            // building trades facade detail for truth — two extruded prisms at
                            // its measured height: the surviving remainder in normal material,
                            // the demolished part as the condemned ghost (absent in Surviving).
                            const height = building3DHeightMeters(bld);
                            const remainder = asFeature(carve.remainder);
                            const demolished = asFeature(carve.demolished);
                            if (remainder) {
                                polygonFeatureToMeshes(remainder, buildingMaterial, 0, height)
                                    .forEach(m => targetGroup.add(m));
                            }
                            if (!hideDemolished && demolished) {
                                polygonFeatureToMeshes(demolished, demolishedMaterial, 0, height)
                                    .forEach(m => targetGroup.add(m));
                            }
                            return;
                        }
                        if (hideDemolished) return; // "Surviving": razed fabric absent
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

        // Priority: the shared-link proposal frame, else the superpolygon of EVERYTHING the
        // user has applied (plus the edge apron below), else the camera point.
        const proposalGeom = proposalFramingGeometry() || appliedWorkFramingGeometry();
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
            const pt = computeCameraFocusGeometry();
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
                console.log(`[3D] Loaded ${nearbyProposalBuildings.length} nearby 3D buildings (${proposalGeom ? 'proposal+' + buffer + 'm' : 'camera+' + buffer + 'm'}${dupCount > 0 ? `, dropped ${dupCount} coincident duplicate${dupCount === 1 ? '' : 's'}` : ''})`);
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

        const proposalGeom = proposalFramingGeometry();
        let geometry, buffer, key;
        if (proposalGeom) {
            geometry = proposalGeom;
            buffer = buildingLoadRadiusM;
            const bb = proposalGeom.coordinates[0];
            key = 'prop:' + bb.map(p => p.map(n => n.toFixed(6)).join(',')).join('|') + '|r' + buildingLoadRadiusM;
        } else {
            const pt = computeCameraFocusGeometry();
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
                console.log(`[3D] Loaded ${nearbyTrees.length} nearby trees (${proposalGeom ? 'proposal' : 'camera'}+${buffer}m)`);
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
        if (treesGroup) treesGroup.visible = treesEnabled;
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

    function rebuild3DBuildingsOnly() {
        if (!isActive || !buildingGroup) return;
        clearGroupChildren(buildingGroup);
        // Bump the generation so in-flight async model loads from a prior rebuild don't
        // attach their meshes to the freshly cleared group.
        buildingsRenderGeneration++;

        // Each family follows its own display state: solid, transparent, or hidden.
        const showExisting = builtDisplay !== 'off';
        const showProposed = plannedDisplay !== 'off';
        if (existingRailGroup) existingRailGroup.visible = showExisting;
        const existingMaterial = (builtDisplay === 'solid' || builtDisplay === 'surviving')
            ? buildingMaterials.solid
            : buildingMaterials.ghost;
        const proposedMaterial = plannedDisplay === 'solid' ? buildingMaterials.solid : buildingMaterials.ghost;

        if (showExisting) buildNearbyProposalBuildings3D(buildingGroup, existingMaterial, builtDisplay === 'surviving');
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

        // Lights
        const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 0.6);
        hemi.position.set(0, 0, 1);
        scene.add(hemi);

        const dir = new THREE.DirectionalLight(0xffffff, 0.8);
        dir.position.set(200, 200, 400);
        scene.add(dir);

        // Groups
        flatGroup = new THREE.Group();
        plannedFlatGroup = new THREE.Group();
        buildingGroup = new THREE.Group();
        parkGroup = new THREE.Group();
        squareGroup = new THREE.Group();
        lakeGroup = new THREE.Group();
        treesGroup = new THREE.Group();
        proposalInteractionGroup = new THREE.Group();
        proposalDraftGroup = new THREE.Group();
        treesEnabled = loadTreesEnabledPref();
        treesGroup.visible = treesEnabled;
        scene.add(flatGroup);
        scene.add(plannedFlatGroup);
        scene.add(buildingGroup);
        scene.add(parkGroup);
        scene.add(squareGroup);
        scene.add(lakeGroup);
        scene.add(treesGroup);
        scene.add(proposalInteractionGroup);
        scene.add(proposalDraftGroup);
        existingRailGroup = null; // rebuilt per scene below (city-gated)

        // Controls
        const OrbitControlsCtor = (THREE.OrbitControls) ? THREE.OrbitControls : (window.OrbitControls || null);
        if (OrbitControlsCtor) {
            controls = new OrbitControlsCtor(camera, renderer.domElement);
            controls.enableDamping = true;
            controls.dampingFactor = 0.05;
            controls.screenSpacePanning = true;
            controls.maxPolarAngle = Math.PI * 0.49; // limit below horizon
            // In the camera-focus fallback mode (no proposal), also refetch on pan end.
            try {
                controls.addEventListener('end', () => {
                    if (!proposalFramingGeometry()) ensureNearbyProposalBuildings();
                });
            } catch (_) { }
        }

        // Build content
        origin3857 = getOrigin3857();
        buildParcels3D(flatGroup);
        buildRoads3D(flatGroup);
        try { buildCorridorStrips3D(flatGroup); } catch (error) { console.warn('[three-mode] corridor strips failed', error); }
        try { buildParks3D(plannedFlatGroup, parkGroup); } catch (_) { }
        try { buildSquares3D(plannedFlatGroup, squareGroup); } catch (_) { }
        try { buildLakes3D(plannedFlatGroup, lakeGroup); } catch (_) { }
        try { buildPlannedReparcellization3D(plannedFlatGroup); } catch (_) { }
        try { buildExistingRail3D(scene); } catch (error) { console.error('[three-mode] elevated rail failed', error); }
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
        isolationKeyHandler = handleIsolationKey;
        document.addEventListener('keydown', isolationKeyHandler);
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
    }

    function hideRenderingOverlay() {
        try {
            if (renderingOverlayEl && renderingOverlayEl.parentNode) {
                renderingOverlayEl.parentNode.removeChild(renderingOverlayEl);
            }
        } catch (_) { }
        renderingOverlayEl = null;
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
        camera.lookAt(ORIGIN);
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
            // Keep north-up orientation consistent with 2D (flip Y)
            const y = -Math.sin(pitchRad) * newDistance;
            const z = Math.cos(pitchRad) * newDistance;
            camera.position.set(0, y, z);
            camera.lookAt(new THREE.Vector3(0, 0, 0));
        } catch (_) { }
    }

    function disposeScene() {
        cancelLoop();
        stopIntroAutoRotate();
        hideRenderingOverlay();
        isTransitioning3D = false;
        if (controls && controls.dispose) {
            try { controls.dispose(); } catch (_) { }
        }
        controls = null;
        // Tear down parcel-isolation listeners and reset state.
        if (renderer && renderer.domElement) {
            if (parcelClickHandler) { try { renderer.domElement.removeEventListener('click', parcelClickHandler); } catch (_) { } }
            if (parcelPointerDownHandler) { try { renderer.domElement.removeEventListener('pointerdown', parcelPointerDownHandler); } catch (_) { } }
        }
        if (isolationKeyHandler) {
            try { document.removeEventListener('keydown', isolationKeyHandler); } catch (_) { }
        }
        parcelClickHandler = null;
        parcelPointerDownHandler = null;
        isolationKeyHandler = null;
        if (proposalSelectionUnsubscribe) {
            try { proposalSelectionUnsubscribe(); } catch (_) { }
            proposalSelectionUnsubscribe = null;
        }
        clickDownXY = null;
        isolatedParcelId = null;
        isolationResetEl = null;
        parcelInfoPanelEl = null;
        displayStateButtons = { built: {}, planned: {} };
        if (renderer) {
            try { renderer.forceContextLoss && renderer.forceContextLoss(); } catch (_) { }
            try { renderer.dispose(); } catch (_) { }
        }
        renderer = null;
        scene = null;
        camera = null;
        flatGroup = null;
        plannedFlatGroup = null;
        buildingGroup = null;
        parkGroup = null;
        squareGroup = null;
        lakeGroup = null;
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
        if (window.activeProposalDraftComparison?.draftId && typeof window.renderProposalDraftComparison === 'function') {
            window.renderProposalDraftComparison(
                window.activeProposalDraftComparison.draftId,
                window.activeProposalDraftComparison.mode || 'overlay'
            );
        }
    }


    // Optional: rebuild content if parcel data reloads while in 3D
    window.addEventListener('parcelDataLoaded', () => {
        if (!isActive) return;
        // Rebuild scene content without re-creating renderer/camera
        if (!scene) { initScene(); return; }
        // The parcel set may have changed entirely — drop any active isolation.
        isolatedParcelId = null;
        updateIsolationButton();
        // Clear groups
        if (flatGroup) {
            for (let i = flatGroup.children.length - 1; i >= 0; i--) flatGroup.remove(flatGroup.children[i]);
        }
        clearGroupChildren(plannedFlatGroup);
        clearGroupChildren(buildingGroup);
        clearGroupChildren(parkGroup);
        clearGroupChildren(squareGroup);
        clearGroupChildren(lakeGroup);
        origin3857 = getOrigin3857();
        buildParcels3D(flatGroup);
        buildRoads3D(flatGroup);
        try { buildCorridorStrips3D(flatGroup); } catch (error) { console.warn('[three-mode] corridor strips failed', error); }
        try { buildParks3D(plannedFlatGroup, parkGroup); } catch (_) { }
        try { buildSquares3D(plannedFlatGroup, squareGroup); } catch (_) { }
        try { buildLakes3D(plannedFlatGroup, lakeGroup); } catch (_) { }
        try { buildPlannedReparcellization3D(plannedFlatGroup); } catch (_) { }
        applyParcelVisibilityForMode(derivedParcelVisibilityMode());
        rebuild3DBuildingsOnly();
        rebuildProposalInteraction3D();
    });

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

    // Rebuild parks/squares/lakes when their 2D state changes. The "flat" portion of each
    // (grounds, paths, water) lives in plannedFlatGroup; the "deco" portion (trees,
    // fountains, fish) lives in its own group. Both clear together so the legacy
    // userData.isParkGround/isSquareGround/isLakeShore filtering on flatGroup is no longer
    // needed.
    window.addEventListener('parksUpdated', () => {
        if (!isActive) return;
        if (!scene) { initScene(); return; }
        clearGroupChildren(plannedFlatGroup);
        clearGroupChildren(parkGroup);
        clearGroupChildren(squareGroup);
        clearGroupChildren(lakeGroup);
        try { buildParks3D(plannedFlatGroup, parkGroup); } catch (_) { }
        try { buildSquares3D(plannedFlatGroup, squareGroup); } catch (_) { }
        try { buildLakes3D(plannedFlatGroup, lakeGroup); } catch (_) { }
        try { buildPlannedReparcellization3D(plannedFlatGroup); } catch (_) { }
        rebuildProposalInteraction3D();
    });

    window.addEventListener('squaresUpdated', () => {
        if (!isActive) return;
        if (!scene) { initScene(); return; }
        clearGroupChildren(plannedFlatGroup);
        clearGroupChildren(parkGroup);
        clearGroupChildren(squareGroup);
        clearGroupChildren(lakeGroup);
        try { buildParks3D(plannedFlatGroup, parkGroup); } catch (_) { }
        try { buildSquares3D(plannedFlatGroup, squareGroup); } catch (_) { }
        try { buildLakes3D(plannedFlatGroup, lakeGroup); } catch (_) { }
        try { buildPlannedReparcellization3D(plannedFlatGroup); } catch (_) { }
        rebuildProposalInteraction3D();
    });

    window.addEventListener('lakesUpdated', () => {
        if (!isActive) return;
        if (!scene) { initScene(); return; }
        clearGroupChildren(plannedFlatGroup);
        clearGroupChildren(parkGroup);
        clearGroupChildren(squareGroup);
        clearGroupChildren(lakeGroup);
        try { buildParks3D(plannedFlatGroup, parkGroup); } catch (_) { }
        try { buildSquares3D(plannedFlatGroup, squareGroup); } catch (_) { }
        try { buildLakes3D(plannedFlatGroup, lakeGroup); } catch (_) { }
        try { buildPlannedReparcellization3D(plannedFlatGroup); } catch (_) { }
        rebuildProposalInteraction3D();
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

    function handleIsolationKey(evt) {
        if (evt.key === 'Escape' && (isolatedParcelId !== null || isolatedProposalId !== null)) clearIsolation();
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
        walkPickKeyHandler = (evt) => {
            if (evt.key === 'Escape') cancelWalkPick();
        };

        // 'click' (not 'mousedown') so OrbitControls drags don't trigger a pick.
        if (renderer && renderer.domElement) {
            renderer.domElement.addEventListener('click', walkPickClickHandler);
        }
        document.addEventListener('keydown', walkPickKeyHandler);
    }

    function cancelWalkPick() {
        if (!walkPickActive) return;
        walkPickActive = false;
        if (walkBtn) walkBtn.classList.remove('active');
        if (threeContainer) threeContainer.classList.remove('three-mode-walk-pick');
        if (renderer && renderer.domElement && walkPickClickHandler) {
            renderer.domElement.removeEventListener('click', walkPickClickHandler);
        }
        if (walkPickKeyHandler) {
            document.removeEventListener('keydown', walkPickKeyHandler);
        }
        walkPickClickHandler = null;
        walkPickKeyHandler = null;
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

    // Expose the current 3D camera as a geographic view so the photorealistic (Cesium) mode can
    // open from the exact same vantage point instead of flying in from space. Returns null when
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
            const pitchRad = polar - Math.PI / 2;           // Cesium: 0 horizon, -π/2 straight down
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
    window.enterThreeMode = enter3D;
    window.exitThreeMode = exit3D;
    window.isThreeModeActive = function () { return isActive; };
    window.getThree3DGeoView = getGeoCameraView;

    document.addEventListener('proposal-draft-preview-change', event => {
        rebuildProposalDraftPreview3D(event.detail || null);
    });

    // Initial paint: mark 2D as the active mode on load.
    updateModeButtonStates();
})();
