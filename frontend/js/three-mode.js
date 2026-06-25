// Three.js 3D Map Mode Overlay for Leaflet map
// - Renders parcels and roads as flat geometry
// - Renders buildings as extruded volumes (default 10m if unknown)
// - Provides tilt-in animation and OrbitControls

(function () {
    if (typeof THREE === 'undefined') {
        console.warn('[3D] THREE.js not available. Skipping 3D mode initialization.');
        return;
    }

    // Internal state
    let isActive = false;
    let scene = null;
    let camera = null;
    let renderer = null;
    let controls = null;
    let frameId = null;
    let origin3857 = null; // Leaflet EPSG:3857 origin for local XY
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
    let treesGroup = null; // real-world OSM trees (Overture base/land), toggleable scenery
    let treesEnabled = true; // user toggle (default ON); real value loaded from storage on 3D init

    // Checkbox listeners to sync 3D buildings with sidebar
    let onShowExistingBuildingsChange = null;
    let onShowProposedBuildingsChange = null;

    const threeContainer = document.getElementById('three-container');
    const toggleBtn = document.getElementById('mode-3d-toggle');
    const walkBtn = document.getElementById('mode-walk-toggle');

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

    // Basic materials
    // - solid: opaque gray, used for the "emphasized" buildings in the current mode.
    // - ghost: translucent gray for context buildings in "both" mode. Darker + higher
    //   opacity than the solid tone so the massing actually reads against the light basemap
    //   (at low opacity over near-white tiles the buildings looked invisible).
    const buildingMaterials = {
        solid: new THREE.MeshPhongMaterial({ color: 0x9aa4ad, specular: 0x333333, shininess: 20, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
        ghost: new THREE.MeshPhongMaterial({ color: 0x6b7682, specular: 0x333333, shininess: 20, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
    };

    const materials = {
        parcels: new THREE.MeshLambertMaterial({ color: 0xdddddd, emissive: 0x000000 }),
        parcelEdges: new THREE.LineBasicMaterial({ color: 0x999999, linewidth: 1, depthTest: false, depthWrite: false }),
        roads: new THREE.MeshLambertMaterial({ color: 0xb0b0b0, emissive: 0x000000 }),
        roadLines: new THREE.LineBasicMaterial({ color: 0x666666, linewidth: 1, depthTest: false, depthWrite: false }),
        sliceEdges: new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 })
    };

    // Building render mode:
    //   'built'   — existing buildings only (solid).
    //   'planned' — proposed buildings only (solid).
    //   'both'    — existing + proposed together; relative opacity controlled by bothEmphasis.
    let buildingRenderMode = 'both';
    // In "both" mode, which type renders solid (opaque) vs ghost (translucent):
    //   'planned' — proposed solid, existing ghost (proposal pops; default).
    //   'built'   — existing solid, proposed ghost (context pops).
    //   'neither' — both ghost, so neither dominates.
    let bothEmphasis = 'planned';
    let buildingModeControlsEl = null;
    let buildingModeButtons = { built: null, both: null, planned: null };
    let bothEmphasisRowEl = null;
    let bothEmphasisButtons = { built: null, planned: null, neither: null };

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
    // Pointer-down position, used to tell a short click apart from an orbit/tilt drag.
    let clickDownXY = null;

    // Scale factor to control how close the camera is vs top-down fit distance.
    // 1.0 means the 3D camera sits at the natural distance to fit the current
    // 2D map viewport — i.e. switching to 3D preserves the user's 2D altitude
    // and just adds tilt, instead of reframing to a different scale.
    const CAMERA_DISTANCE_SCALE = 1.0;

    function updateBuildingModeButtons() {
        try {
            Object.keys(buildingModeButtons).forEach((key) => {
                const btn = buildingModeButtons[key];
                if (!btn) return;
                if (key === buildingRenderMode) {
                    btn.classList.add('three-mode-segment--active');
                    btn.setAttribute('aria-pressed', 'true');
                } else {
                    btn.classList.remove('three-mode-segment--active');
                    btn.setAttribute('aria-pressed', 'false');
                }
            });
        } catch (_) { }
    }

    function updateBothEmphasisButtons() {
        try {
            // The emphasis row only makes sense in "both" mode.
            if (bothEmphasisRowEl) bothEmphasisRowEl.style.display = (buildingRenderMode === 'both') ? '' : 'none';
            Object.keys(bothEmphasisButtons).forEach((key) => {
                const btn = bothEmphasisButtons[key];
                if (!btn) return;
                if (key === bothEmphasis) {
                    btn.classList.add('three-mode-segment--active');
                    btn.setAttribute('aria-pressed', 'true');
                } else {
                    btn.classList.remove('three-mode-segment--active');
                    btn.setAttribute('aria-pressed', 'false');
                }
            });
        } catch (_) { }
    }

    function setBothEmphasis(emphasis) {
        if (emphasis !== 'built' && emphasis !== 'planned' && emphasis !== 'neither') return;
        if (emphasis === bothEmphasis) return;
        bothEmphasis = emphasis;
        updateBothEmphasisButtons();
        // Only changes materials, and only matters in "both" mode.
        if (buildingRenderMode === 'both') rebuild3DBuildingsOnly();
    }

    // Apply the visibility implied by the current buildingRenderMode (no isolation).
    function applyModeVisibility() {
        const mode = buildingRenderMode;
        // Planned structures (park/square/lake grounds + their decorations) are not shown
        // in Built view. Both the flat half (grounds, paths, water) and the deco half
        // (trees, fountains, fish) toggle together.
        const showPlanned = mode !== 'built';
        if (plannedFlatGroup) plannedFlatGroup.visible = showPlanned;
        if (parkGroup) parkGroup.visible = showPlanned;
        if (squareGroup) squareGroup.visible = showPlanned;
        if (lakeGroup) lakeGroup.visible = showPlanned;
        // Built mode also hides parcels created by applied proposals so the cadastre reflects
        // the pre-proposal state (modulo the holes where ancestors used to be).
        applyParcelVisibilityForMode(mode);
    }

    function setBuildingRenderMode(mode) {
        if (mode !== 'built' && mode !== 'planned' && mode !== 'both') return;
        if (mode === buildingRenderMode) return;
        buildingRenderMode = mode;
        updateBuildingModeButtons();
        updateBothEmphasisButtons();
        // Switching mode drops out of parcel isolation so the new mode is shown in full.
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

    // Ground-plane footprint polygon (lng/lat) of a nearby 3D building, from the convex hull
    // of all its face vertices. Cached on the building object since it never changes.
    function buildingFootprintPolygon(bld) {
        if (!bld || !Array.isArray(bld.faces)) return null;
        if (bld.__footprintPolygon !== undefined) return bld.__footprintPolygon;
        const pts = [];
        for (const face of bld.faces) {
            if (!face || !Array.isArray(face.coordinates)) continue;
            for (const ring of face.coordinates) {
                if (!Array.isArray(ring)) continue;
                for (const c of ring) {
                    if (c && c.length >= 2 && isFinite(c[0]) && isFinite(c[1])) {
                        pts.push(turf.point([c[0], c[1]]));
                    }
                }
            }
        }
        let hull = null;
        if (pts.length >= 3) {
            try { hull = turf.convex(turf.featureCollection(pts)); } catch (_) { hull = null; }
        }
        bld.__footprintPolygon = hull;
        return hull;
    }

    // Built/proposed volume (m³), derived floor area (m²) and the € value gain for one parcel.
    // Built volume comes from the existing 3D buildings (footprint ∩ parcel × their height);
    // proposed volume from window.proposedBuildings the same way. Floor area = volume / storey
    // height; gain = (proposed − built) floor area × price.
    function computeParcelMetrics(parcelId) {
        const parcel = getParcelFeatureById(parcelId);
        if (!parcel) return null;

        let builtVolume = 0;
        const builtList = Array.isArray(nearbyProposalBuildings) ? nearbyProposalBuildings : [];
        for (const bld of builtList) {
            const h = (Number.isFinite(bld.z_max) && Number.isFinite(bld.z_min)) ? (bld.z_max - bld.z_min) : 0;
            if (!(h > 0)) continue;
            const fp = buildingFootprintPolygon(bld);
            if (!fp) continue;
            let inter = null;
            try { inter = turf.intersect(fp, parcel); } catch (_) { inter = null; }
            if (!inter) continue;
            let a = 0;
            try { a = turf.area(inter); } catch (_) { a = 0; }
            builtVolume += a * h;
        }

        let proposedVolume = 0;
        const proposed = Array.isArray(window.proposedBuildings) ? window.proposedBuildings : [];
        for (const feat of proposed) {
            if (!feat || !feat.geometry) continue;
            const h = estimateBuildingHeightMeters(feat);
            if (!(h > 0)) continue;
            let inter = null;
            try { inter = turf.intersect(feat, parcel); } catch (_) { inter = null; }
            if (!inter) continue;
            let a = 0;
            try { a = turf.area(inter); } catch (_) { a = 0; }
            proposedVolume += a * h;
        }

        const builtFloorArea = builtVolume / FLOOR_HEIGHT_M;
        const proposedFloorArea = proposedVolume / FLOOR_HEIGHT_M;
        return { builtVolume, proposedVolume, builtFloorArea, proposedFloorArea };
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

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    // --- Proposal lookup helpers (for the "Proposal info" view) ---
    function getProposalForParcel(parcelId) {
        try {
            const store = (typeof window !== 'undefined') ? window.proposalStorage : null;
            if (!store || typeof store.getProposalsForParcel !== 'function') return null;
            const list = store.getProposalsForParcel(parcelId) || [];
            if (!list.length) return null;
            // Prefer an applied/executed proposal; else the first match.
            const applied = list.find(p => {
                const s = ((p && p.status) || '').toString().toLowerCase();
                return s === 'applied' || s === 'executed';
            });
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
        const gain = (proposed - built) * priceEurPerM2;

        const titleEl = panel.querySelector('[data-role="value-title"]');
        if (titleEl) titleEl.textContent = threeI18n('threeMode.parcelPanel.valueTitle', 'Value @ €{{p}}/m²', { p: formatInt(priceEurPerM2) });

        const gainEl = panel.querySelector('[data-role="gain"]');
        if (gainEl) {
            // No proposed massing on this parcel → there's no "gain", just the current
            // built value. Show that as a positive figure instead of a negative delta.
            if (proposed <= 0) {
                const currentValue = built * priceEurPerM2;
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
            if (lastParcelCount && lastParcelCount > 0 && proposed > 0) {
                const avg = gain / lastParcelCount;
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
        [plannedFlatGroup, parkGroup, squareGroup, lakeGroup].forEach(g => { if (g) g.visible = false; });
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
            updateBuildingModeButtons();
            updateBothEmphasisButtons();
            return;
        }

        buildingModeControlsEl = document.createElement('div');
        buildingModeControlsEl.className = 'three-mode-ui-panel';
        buildingModeControlsEl.setAttribute('role', 'group');
        buildingModeControlsEl.setAttribute('aria-label', 'Building rendering');

        const builtBtn = document.createElement('button');
        builtBtn.type = 'button';
        builtBtn.className = 'three-mode-segment';
        builtBtn.textContent = 'Built';
        builtBtn.addEventListener('click', () => setBuildingRenderMode('built'));

        const bothBtn = document.createElement('button');
        bothBtn.type = 'button';
        bothBtn.className = 'three-mode-segment';
        bothBtn.textContent = 'Both';
        bothBtn.addEventListener('click', () => setBuildingRenderMode('both'));

        const plannedBtn = document.createElement('button');
        plannedBtn.type = 'button';
        plannedBtn.className = 'three-mode-segment';
        plannedBtn.textContent = 'Planned';
        plannedBtn.addEventListener('click', () => setBuildingRenderMode('planned'));

        buildingModeButtons = { built: builtBtn, both: bothBtn, planned: plannedBtn };

        const buttonWrap = document.createElement('div');
        buttonWrap.className = 'three-mode-segmented';
        buttonWrap.appendChild(builtBtn);
        buttonWrap.appendChild(bothBtn);
        buttonWrap.appendChild(plannedBtn);
        buildingModeControlsEl.appendChild(buttonWrap);

        // Radius row — controls how wide a band of built context is loaded/rendered.
        const radiusRow = document.createElement('div');
        radiusRow.className = 'three-mode-radius-row';

        const radiusHeader = document.createElement('div');
        radiusHeader.className = 'three-mode-radius-header';
        const radiusLabel = document.createElement('span');
        radiusLabel.className = 'three-mode-emphasis-label';
        radiusLabel.textContent = 'Radius';
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

        // Trees toggle — real-world OSM trees (Overture) as ambient scenery. Independent of the
        // Built/Planned mode; off-by-default cities (no ingested trees) simply render nothing.
        const treesRow = document.createElement('div');
        treesRow.className = 'three-mode-trees-row';
        const treesToggleLabel = document.createElement('label');
        treesToggleLabel.className = 'three-mode-trees-toggle';
        const treesCheckbox = document.createElement('input');
        treesCheckbox.type = 'checkbox';
        treesCheckbox.checked = loadTreesEnabledPref();
        treesCheckbox.addEventListener('change', () => setTreesEnabled(treesCheckbox.checked));
        const treesText = document.createElement('span');
        treesText.className = 'three-mode-emphasis-label';
        treesText.textContent = 'Trees';
        treesToggleLabel.appendChild(treesCheckbox);
        treesToggleLabel.appendChild(treesText);
        treesRow.appendChild(treesToggleLabel);
        buildingModeControlsEl.appendChild(treesRow);

        // Emphasis sub-row (only shown in "both" mode): picks which type renders solid.
        bothEmphasisRowEl = document.createElement('div');
        bothEmphasisRowEl.className = 'three-mode-emphasis-row';

        const emphasisLabel = document.createElement('span');
        emphasisLabel.className = 'three-mode-emphasis-label';
        emphasisLabel.textContent = 'Solid:';
        bothEmphasisRowEl.appendChild(emphasisLabel);

        const emBuiltBtn = document.createElement('button');
        emBuiltBtn.type = 'button';
        emBuiltBtn.className = 'three-mode-segment';
        emBuiltBtn.textContent = 'Built';
        emBuiltBtn.addEventListener('click', () => setBothEmphasis('built'));

        const emPlannedBtn = document.createElement('button');
        emPlannedBtn.type = 'button';
        emPlannedBtn.className = 'three-mode-segment';
        emPlannedBtn.textContent = 'Planned';
        emPlannedBtn.addEventListener('click', () => setBothEmphasis('planned'));

        const emNeitherBtn = document.createElement('button');
        emNeitherBtn.type = 'button';
        emNeitherBtn.className = 'three-mode-segment';
        emNeitherBtn.textContent = 'Neither';
        emNeitherBtn.addEventListener('click', () => setBothEmphasis('neither'));

        bothEmphasisButtons = { built: emBuiltBtn, planned: emPlannedBtn, neither: emNeitherBtn };

        const emphasisWrap = document.createElement('div');
        emphasisWrap.className = 'three-mode-segmented';
        emphasisWrap.appendChild(emBuiltBtn);
        emphasisWrap.appendChild(emPlannedBtn);
        emphasisWrap.appendChild(emNeitherBtn);
        bothEmphasisRowEl.appendChild(emphasisWrap);
        buildingModeControlsEl.appendChild(bothEmphasisRowEl);

        // Show-all reset, only visible while a parcel is isolated.
        isolationResetEl = document.createElement('div');
        isolationResetEl.className = 'three-mode-emphasis-row';
        const showAllBtn = document.createElement('button');
        showAllBtn.type = 'button';
        showAllBtn.className = 'three-mode-reset-btn';
        showAllBtn.textContent = 'Show all parcels';
        showAllBtn.addEventListener('click', () => clearIsolation());
        isolationResetEl.appendChild(showAllBtn);
        buildingModeControlsEl.appendChild(isolationResetEl);

        threeContainer.appendChild(buildingModeControlsEl);
        updateBuildingModeButtons();
        updateBothEmphasisButtons();
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

    function getOrigin3857() {
        // Anchor the local XY frame on the proposal being viewed so it sits at the scene
        // origin and the built context loads around it. Fall back to the 2D map center when
        // there is no proposal (free 3D browsing) — keeps entry deterministic either way.
        const center = getProposalCenterLatLng()
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
        const toVec2 = (pt) => {
            const xy = coordsToXY(pt);
            return new THREE.Vector2(xy[0], xy[1]);
        };

        const outer = rings[0].map(toVec2);
        const shape = new THREE.Shape(outer);
        for (let i = 1; i < rings.length; i++) {
            const holePath = new THREE.Path(rings[i].map(toVec2));
            shape.holes.push(holePath);
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

    function buildParks3D(flatTarget, decoTarget) {
        const parks = (typeof window !== 'undefined' && Array.isArray(window.parks)) ? window.parks : [];
        if (!parks || parks.length === 0) return;
        // Use polygonOffset to float slightly over base to avoid z-fighting and flicker
        const grassMat = new THREE.MeshLambertMaterial({ color: 0x1b5e20, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6d4c41 });
        const treeMat = new THREE.MeshLambertMaterial({ color: 0x2e7d32 });
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

                // Simple 3D trees as trunk + cone crown at sampled interior points
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
                    const [lng, lat] = rnd.geometry.coordinates;
                    const [x, y] = latLngToXY(lat, lng);
                    const trunkH = 3 + Math.random() * 2;
                    const crownH = 4 + Math.random() * 3;
                    const trunkR = 0.45 + Math.random() * 0.35;
                    const crownR = 1.8 + Math.random() * 1.2;

                    const trunkGeo = new THREE.CylinderGeometry(trunkR, trunkR, trunkH, 8);
                    trunkGeo.rotateX(Math.PI / 2); // stand upright along Z
                    trunkGeo.translate(x, y, trunkH / 2);
                    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
                    decoTarget.add(trunk);

                    const crownGeo = new THREE.ConeGeometry(crownR, crownH, 8);
                    crownGeo.rotateX(Math.PI / 2); // stand upright along Z
                    crownGeo.translate(x, y, trunkH + crownH / 2);
                    const crown = new THREE.Mesh(crownGeo, treeMat);
                    decoTarget.add(crown);
                    placed++;
                }
            } catch (_) { }
        });
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
                if (!dec || !Array.isArray(dec.fountain)) return;
                const [lng, lat] = dec.fountain;
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

                // Render shore (sandy beach) well above ground to avoid z-fighting with parcels
                if (shoreGeom) {
                    const shoreFeature = { type: 'Feature', geometry: shoreGeom, properties: {} };
                    const shoreMeshes = polygonFeatureToMeshes(shoreFeature, shoreMat, 1.0, 0);
                    shoreMeshes.forEach(m => { m.userData.isLakeShore = true; flatTarget.add(m); });
                }

                // Render transition zone (shallow water) above shore
                if (transitionGeom) {
                    const transitionFeature = { type: 'Feature', geometry: transitionGeom, properties: {} };
                    const transitionMeshes = polygonFeatureToMeshes(transitionFeature, transitionMat, 2.0, 0);
                    transitionMeshes.forEach(m => flatTarget.add(m));
                }

                // Render water (deep water) above transition
                if (waterGeom) {
                    const waterFeature = { type: 'Feature', geometry: waterGeom, properties: {} };
                    const waterMeshes = polygonFeatureToMeshes(waterFeature, waterMat, 3.0, 0);
                    waterMeshes.forEach(m => flatTarget.add(m));
                } else {
                    // Fallback: render entire lake as water if no water geometry
                    const waterMeshes = polygonFeatureToMeshes(lake, waterMat, 3.0, 0);
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
                        fish.position.set(x, y, 0.08);
                        decoTarget.add(fish);
                    } catch (_) { }
                });
            } catch (_) { }
        });
    }

    function estimateBuildingHeightMeters(feature) {
        try {
            const props = feature.properties || {};
            if (typeof props.height === 'number' && isFinite(props.height) && props.height > 0) return props.height;
            if (typeof props.HEIGHT === 'number' && isFinite(props.HEIGHT) && props.HEIGHT > 0) return props.HEIGHT;
            if (typeof props.elevation === 'number' && isFinite(props.elevation) && props.elevation > 0) return props.elevation;
            // stories/levels fallback
            const levels = props.levels || props.storeys || props.stories || props.LEVELS || props.STORIES;
            if (typeof levels === 'number' && isFinite(levels) && levels > 0) return levels * 3.3;
        } catch (_) { }
        return 10; // default 3 stories ~10 meters
    }

    function buildParcels3D(targetGroup) {
        if (typeof parcelLayer === 'undefined' || !parcelLayer) return;
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
            const meshes = polygonFeatureToMeshes(f, fillMat, 0, 0);
            meshes.forEach(m => { tag(m); targetGroup.add(m); });
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

    function buildNearbyProposalBuildings3D(targetGroup, buildingMaterial) {
        // Existing buildings in the 3D view are drawn entirely from the `building_3d` city
        // model fetched via POST /buildings/near. The 2D Leaflet buildingLayer (DKP_ZGRADE
        // via WFS) is no longer used here — it has only 2D footprints with no heights.
        try {
            if (Array.isArray(nearbyProposalBuildings) && nearbyProposalBuildings.length > 0) {
                nearbyProposalBuildings.forEach(bld => {
                    try {
                        const mesh = buildMeshFromBuilding3D(bld, buildingMaterial);
                        if (mesh) targetGroup.add(mesh);
                    } catch (e) {
                        console.warn('Failed to build 3D mesh for building', bld && bld.object_id, e);
                    }
                });
            }
        } catch (_) { }
        ensureNearbyProposalBuildings();
    }

    // Build a THREE.Mesh from a { object_id, z_min, faces[] } building returned by /buildings/near.
    // Each face is a flat 3D polygon (wall section or roof panel). We triangulate each face in
    // its best-fit 2D plane, then lift the triangles back to their original 3D vertices.
    function buildMeshFromBuilding3D(bld, material) {
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
            const outer = convertedRings[0];
            const holes = convertedRings.slice(1);

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
                for (let k = 0; k < 3; k++) {
                    const v = flat3D[tri[k]];
                    if (!v) continue;
                    positions.push(v[0], v[1], v[2]);
                }
            }
        }

        if (positions.length === 0) return null;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.computeVertexNormals();

        // Use a two-sided material clone so back faces (from inconsistent winding in source data) still render.
        const mat = material.clone();
        mat.side = THREE.DoubleSide;
        const mesh = new THREE.Mesh(geometry, mat);
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

    // --- Nearby buildings (sourced from building_3d via POST /buildings/near) ---
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
        try {
            const bbox = turf.bbox(turf.featureCollection(features));
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

    function ensureNearbyProposalBuildings() {
        if (nearbyProposalBuildingsFetching) return;

        const proposalGeom = computeProposalQueryGeometry();
        let geometry, buffer, key;
        if (proposalGeom) {
            geometry = proposalGeom;
            buffer = buildingLoadRadiusM;
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
                nearbyProposalBuildings = (payload && Array.isArray(payload.buildings)) ? payload.buildings : [];
                nearbyProposalBuildingsKey = key;
                nearbyProposalBuildingsFetching = false;
                console.log(`[3D] Loaded ${nearbyProposalBuildings.length} nearby 3D buildings (${proposalGeom ? 'proposal+' + buffer + 'm' : 'camera+' + buffer + 'm'})`);
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

        const proposalGeom = computeProposalQueryGeometry();
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
        const ghost = !!(buildingMaterial && buildingMaterial.transparent && buildingMaterial.opacity < 1);
        const opacity = ghost ? buildingMaterial.opacity : 1;
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

            wrapper.traverse((node) => {
                if (!node.isMesh || !node.material) return;
                const mats = Array.isArray(node.material) ? node.material : [node.material];
                mats.forEach((m) => {
                    if (!m) return;
                    m.transparent = ghost;
                    m.opacity = opacity;
                    m.depthWrite = !ghost;
                    m.needsUpdate = true;
                });
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

        sliceData.forEach((slice, i) => {
            try {
                const sliceMaterial = material.clone();
                const shadedColor = baseColor.clone();
                const hsl = {};
                shadedColor.getHSL(hsl);
                // Alternate lighter/darker per parcel so adjacent slices read as distinct parcels.
                const lightnessShift = (shade[i] === 0) ? 0.14 : -0.14;
                hsl.l = Math.max(0.2, Math.min(0.8, hsl.l + lightnessShift));
                shadedColor.setHSL(hsl.h, hsl.s, hsl.l);
                sliceMaterial.color.set(shadedColor);

                const sliceMeshes = polygonFeatureToMeshes(slice.intersection, sliceMaterial, 0, height);

                // Tag the slice with its parcel so parcel-isolation can match the
                // building footprint sitting on a clicked parcel.
                const sliceParcelId = (slice.parcelFeature.properties && slice.parcelFeature.properties.parcelId != null)
                    ? String(slice.parcelFeature.properties.parcelId) : null;

                sliceMeshes.forEach(mesh => {
                    if (sliceParcelId) mesh.userData.parcelId = sliceParcelId;
                    targetGroup.add(mesh);
                    const edges = new THREE.EdgesGeometry(mesh.geometry);
                    const line = new THREE.LineSegments(edges, materials.sliceEdges);
                    if (sliceParcelId) line.userData.parcelId = sliceParcelId;
                    targetGroup.add(line);
                });
            } catch (e) {
                console.warn("Error creating building slice", e);
            }
        });

        const slices = n;
        if (slices === 0 || (totalBuildingArea > 0 && (slicedArea / totalBuildingArea) < 0.95)) {
            if (slices > 0) {
                console.warn("Slicing did not cover the whole building, drawing remainder.");
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

        // The 3-state toggle is the single source of truth inside the 3D view.
        //   built   → nearby existing buildings only, solid
        //   planned → proposed buildings only, solid
        //   both    → existing + proposed together; bothEmphasis decides which is solid vs ghost
        const showExisting = buildingRenderMode === 'built' || buildingRenderMode === 'both';
        const showProposed = buildingRenderMode === 'planned' || buildingRenderMode === 'both';
        let existingMaterial = buildingMaterials.solid;
        let proposedMaterial = buildingMaterials.solid;
        if (buildingRenderMode === 'both') {
            // 'planned' → proposed pops; 'built' → context pops; 'neither' → both translucent.
            existingMaterial = (bothEmphasis === 'built') ? buildingMaterials.solid : buildingMaterials.ghost;
            proposedMaterial = (bothEmphasis === 'planned') ? buildingMaterials.solid : buildingMaterials.ghost;
        }

        if (showExisting) buildNearbyProposalBuildings3D(buildingGroup, existingMaterial);
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
        // When a proposal is in view, frame the proposal plus a margin for its built
        // surroundings, centred on the origin (= proposal centre). This makes entering 3D
        // always land on the proposal, regardless of where the 2D map was panned/zoomed.
        const proposalGeom = computeProposalQueryGeometry();
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

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, logarithmicDepthBuffer: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        threeContainer.innerHTML = '';
        threeContainer.appendChild(renderer.domElement);
        ensureBuildingModeControls();

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
        treesEnabled = loadTreesEnabledPref();
        treesGroup.visible = treesEnabled;
        scene.add(flatGroup);
        scene.add(plannedFlatGroup);
        scene.add(buildingGroup);
        scene.add(parkGroup);
        scene.add(squareGroup);
        scene.add(lakeGroup);
        scene.add(treesGroup);

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
                    if (!computeProposalQueryGeometry()) ensureNearbyProposalBuildings();
                });
            } catch (_) { }
        }

        // Build content
        origin3857 = getOrigin3857();
        buildParcels3D(flatGroup);
        buildRoads3D(flatGroup);
        try { buildParks3D(plannedFlatGroup, parkGroup); } catch (_) { }
        try { buildSquares3D(plannedFlatGroup, squareGroup); } catch (_) { }
        try { buildLakes3D(plannedFlatGroup, lakeGroup); } catch (_) { }
        // Apply initial visibility based on current mode (default is 'both').
        const showPlanned = buildingRenderMode !== 'built';
        if (plannedFlatGroup) plannedFlatGroup.visible = showPlanned;
        if (parkGroup) parkGroup.visible = showPlanned;
        if (squareGroup) squareGroup.visible = showPlanned;
        if (lakeGroup) lakeGroup.visible = showPlanned;
        applyParcelVisibilityForMode(buildingRenderMode);
        rebuild3DBuildingsOnly();

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
            el.textContent = 'Rendering…';
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
        label.textContent = 'Loading buildings…';
        el.appendChild(spinner);
        el.appendChild(label);
        threeContainer.appendChild(el);
        buildingsLoaderEl = el;
        return el;
    }

    // Visible whenever either source of building loading is in flight (and 3D is active).
    function updateBuildingsLoader() {
        try {
            const loading = isActive && (nearbyProposalBuildingsFetching || pendingModelLoads > 0);
            const el = ensureBuildingsLoaderEl();
            if (el) el.classList.toggle('is-visible', loading);
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
        // We are ready: hide overlay and set the button label to 2D
        hideRenderingOverlay();
        isTransitioning3D = false;
        if (toggleBtn && isActive) {
            toggleBtn.textContent = '2D';
            toggleBtn.title = 'Switch to 2D';
        }
        console.log('[3D] startLoop() called, pendingIntroAutoRotate:', pendingIntroAutoRotate);
        if (pendingIntroAutoRotate) {
            pendingIntroAutoRotate = false;
            console.log('[3D] Starting intro auto-rotate');
            startIntroAutoRotate();
        }
        const loop = (now) => {
            stepManualAutoRotate(now);
            if (controls) controls.update();
            // Dynamically adjust near/far planes based on camera distance to maintain depth precision
            if (camera) {
                const dist = camera.position.length();
                camera.near = Math.max(1, dist * 0.001);
                camera.far = Math.max(1000, dist * 10);
                camera.updateProjectionMatrix();
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
        clickDownXY = null;
        isolatedParcelId = null;
        isolationResetEl = null;
        parcelInfoPanelEl = null;
        bothEmphasisRowEl = null;
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
        try { typeof hideParcelInfoPanel === 'function' && hideParcelInfoPanel(); } catch (_) { }
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
        pendingIntroAutoRotate = !!(options && options.fromUrl);
        if (pendingIntroAutoRotate) {
            console.log('[3D] URL-driven entry detected, will start auto-rotate after tilt animation');
        }
        try { document.body.classList.add('three-mode-active'); } catch (_) { }
        if (threeContainer) threeContainer.classList.add('active');
        if (toggleBtn) {
            toggleBtn.classList.add('active');
            toggleBtn.textContent = 'Rendering…';
            toggleBtn.title = 'Preparing 3D view';
        }
        // Only show the walk launcher for cities that configure a walk overlay (e.g. Zagreb).
        if (walkBtn) walkBtn.hidden = !getWalkUrlBase();
        showRenderingOverlay();
        disableLeafletInteractions();
        closeAllPanelsAndModalsFor3D();
        disableSidebarFor3D();
        initScene();
    }

    function exit3D() {
        try { document.body.classList.remove('three-mode-active'); } catch (_) { }
        if (!isActive) return;
        isActive = false;
        stopIntroAutoRotate();
        cancelWalkPick();
        if (walkBtn) walkBtn.hidden = true;
        if (threeContainer) threeContainer.classList.remove('active');
        if (toggleBtn) {
            toggleBtn.classList.remove('active');
            toggleBtn.textContent = '3D';
            toggleBtn.title = 'Switch to 3D';
        }
        enableLeafletInteractions();
        enableSidebarAfter3D();
        pendingModelLoads = 0;
        updateBuildingsLoader();
        disposeScene();
    }

    function toggle3D() {
        if (isActive) exit3D(); else enter3D();
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
        try { buildParks3D(plannedFlatGroup, parkGroup); } catch (_) { }
        try { buildSquares3D(plannedFlatGroup, squareGroup); } catch (_) { }
        try { buildLakes3D(plannedFlatGroup, lakeGroup); } catch (_) { }
        applyParcelVisibilityForMode(buildingRenderMode);
        rebuild3DBuildingsOnly();
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
    });

    // Wire button
    if (toggleBtn) {
        toggleBtn.addEventListener('click', function () {
            if (isActive) {
                // Exit immediately
                toggle3D();
                return;
            }
            if (isTransitioning3D) return;
            isTransitioning3D = true;
            // Show immediate feedback in 2D before heavy work starts
            if (toggleBtn) {
                toggleBtn.classList.add('active');
                toggleBtn.textContent = 'Rendering…';
                toggleBtn.title = 'Preparing 3D view';
            }
            showRenderingOverlay();
            // Defer heavy initialization to allow the overlay/button to paint first
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    enter3D();
                });
            });
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
            const isAppliedLike = (status) => {
                const s = (status || '').toString().toLowerCase();
                return s === 'applied' || s === 'executed';
            };
            return storage.getAllProposals().filter(p => {
                if (!p) return false;
                if (isAppliedLike(p.status)) return true;
                if (p.roadProposal && isAppliedLike(p.roadProposal.status)) return true;
                if (p.buildingProposal && isAppliedLike(p.buildingProposal.status)) return true;
                if (p.structureProposal && isAppliedLike(p.structureProposal.status)) return true;
                if (p.reparcellization && isAppliedLike(p.reparcellization.status)) return true;
                if (p.decideLaterProposal && isAppliedLike(p.decideLaterProposal.status)) return true;
                return false;
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
        const base = getWalkUrlBase();
        if (!base) return null;
        return `${base}?${params.toString()}`;
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

    // Raycast a click against parcels/buildings and return the hit parcelId (or null).
    // Skips invisible objects so an isolated scene only "hits" what's actually shown.
    function pickParcelIdFromEvent(evt) {
        if (!renderer || !camera) return null;
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(
            ((evt.clientX - rect.left) / rect.width) * 2 - 1,
            -((evt.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, camera);
        const targets = [];
        if (buildingGroup) targets.push(buildingGroup);
        if (flatGroup) targets.push(flatGroup);
        const hits = raycaster.intersectObjects(targets, true);
        for (const h of hits) {
            const obj = h.object;
            if (!obj || obj.visible === false) continue;
            if (obj.userData && obj.userData.parcelId) return obj.userData.parcelId;
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
        const pid = pickParcelIdFromEvent(evt);
        // Click on empty ground, or on the already-isolated parcel, returns to full view.
        if (!pid || pid === isolatedParcelId) { clearIsolation(); return; }
        isolateParcel(pid);
    }

    function handleIsolationKey(evt) {
        if (evt.key === 'Escape' && (isolatedParcelId !== null || isolatedProposalId !== null)) clearIsolation();
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
            if (!ll) {
                console.warn('[walk] click missed the ground plane');
                return;
            }
            try {
                const url = buildWalkUrl(ll.lat, ll.lng);
                if (!url) { console.warn('[walk] no walk overlay configured for this city'); return; }
                window.open(url, '_blank', 'noopener,noreferrer');
            } catch (e) {
                console.warn('[walk] failed to open walk URL:', e);
            }
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
                startWalkPick();
                return;
            }

            // Some applied proposals lack a numeric serverProposalId, so the walk page can't
            // load them. Open the upload-gate modal; it auto-closes when the list is empty
            // and then we drop straight into the walk pick.
            if (typeof window.showWalkUploadGateModal === 'function') {
                window.showWalkUploadGateModal({
                    onComplete: () => {
                        if (!isActive) return;
                        if (getNonUploadedAppliedProposals().length === 0) startWalkPick();
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
})();


