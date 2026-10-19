// Suggested layouts on the 2D map: the ground floor of the default layout that default-floor-plans.js
// suggests for each proposed building without a modelled interior, drawn per parcel slice over the
// proposed buildings, and the slices too small for a minimum stair core outlined red and dashed.
// Display only, like the 3D suggestion: nothing is written to any proposal. Planning, grouping and
// styling are pure helpers that node tests drive; only setEnabled()/install() touch Leaflet and the page.
(function (global) {
    'use strict';

    const PANE = 'suggestedLayoutsPane';
    // Just above the proposed-buildings canvas (645, building-blocks.js): beneath it the plan would sit
    // under a 45 % blue fill and the red flags would read purple. Below the tooltips (650) and the
    // corridor panes (655+). The pane takes no pointer events, so the parcels below keep their clicks.
    const PANE_Z_INDEX = '646';
    const MIN_ZOOM = 17;          // the zoom the parcels and every building layer load from (map-core.js)
    const VIEW_PAD = 0.25;        // plan a quarter viewport past each edge, so a short pan shows them at once
    const DEFAULT_HEIGHT_M = 10;  // building-height.js's default, for when the 3D stack has not loaded it
    const URL_FLAG = 'suggested2d';
    const TOGGLE_ID = 'showSuggestedLayouts';

    // Path options per style, listed bottom to top. Colours are roles: css/map.css maps each role to a
    // token (--suggested-layout-<role>) and colours the class; the wiring reads the same properties back
    // for the inline colour Leaflet writes, so a renderer without classes draws the same thing.
    const STYLES = {
        slab: { stroke: 'line', fill: 'slab', options: { weight: 0.5, opacity: 1, fillOpacity: 0.85 } },
        landing: { fill: 'core', options: { stroke: false, fillOpacity: 0.5 } },
        wall: { stroke: 'wall', fill: 'wall', options: { weight: 1, opacity: 1, fillOpacity: 1 } },
        stair: { stroke: 'core', options: { weight: 3, opacity: 0.9, dashArray: '2 2', lineCap: 'butt', fill: false } },
        railing: { stroke: 'core', options: { weight: 1, opacity: 0.9, fill: false } },
        window: { stroke: 'window', options: { weight: 3, opacity: 1, lineCap: 'butt', fill: false } },
        door: { stroke: 'door', options: { weight: 3, opacity: 1, lineCap: 'butt', fill: false } },
        'glazed-door': { stroke: 'entrance', options: { weight: 4, opacity: 1, lineCap: 'butt', fill: false } },
        'sliding-door': { stroke: 'lift', options: { weight: 3, opacity: 1, lineCap: 'butt', fill: false } },
        flagged: { stroke: 'flagged', fill: 'flagged', options: { weight: 2, opacity: 1, dashArray: '6 4', fillOpacity: 0.15 } }
    };
    const DRAW_ORDER = Object.keys(STYLES);
    const OPENING_STYLES = { window: 'window', door: 'door', glazedDoor: 'glazed-door', slidingDoor: 'sliding-door' };
    const PALETTE_ROLES = ['slab', 'line', 'wall', 'core', 'window', 'door', 'entrance', 'lift', 'flagged'];

    // ---- pure helpers -------------------------------------------------------------------------

    const positive = value => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; };
    function bboxOf(feature, turf) { try { return turf.bbox(feature); } catch (_) { return null; } }
    const overlaps = (a, b) => !!a && !!b && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

    // The features whose bounding box reaches `bbox` ([w, s, e, n]).
    function withinBbox(features, bbox, turf) {
        return (Array.isArray(features) ? features : []).filter(feature => feature && feature.geometry && overlaps(bbox, bboxOf(feature, turf)));
    }

    // The drawn height in metres: the shared estimator (building-height.js) once the 3D stack has loaded
    // it, else the building's own height, else the same 10 m default.
    function heightOfBuilding(feature, estimator) {
        if (typeof estimator === 'function') return estimator(feature);
        return positive(feature && feature.properties && feature.properties.height) ?? DEFAULT_HEIGHT_M;
    }

    // A building that already shows an interior of its own keeps it: an evidence model (floorPlans) or
    // an uploaded glTF (modelUrl). The same rule as the 3D view.
    function needsSuggestion(feature) {
        const p = (feature && feature.properties) || {};
        return !!(feature && feature.geometry) && !p.floorPlans && !p.modelUrl;
    }

    /**
     * The suggested layout of every proposed building that needs one, one entry per parcel slice.
     * @param deps { proposedBuildings, parcelsFor(feature), neighbourPool(feature), context
     *   (default-floor-plan-context.js), generator (default-floor-plans.js), turf, heightOf(feature),
     *   storeyFallbackM, cache?, rules?, region? }. No roads: the entrance faces the longest facade.
     * @returns [{ building, parcelId, footprint, floorPlans | null, warnings, error? }]
     */
    function collectLayouts(deps) {
        const { proposedBuildings, parcelsFor, neighbourPool, context, generator, turf, heightOf, storeyFallbackM, cache, rules, region } = deps || {};
        if (!context || !generator || !turf) throw new Error('suggested-layouts-2d: context, generator and turf are required');
        const out = [];
        for (const building of Array.isArray(proposedBuildings) ? proposedBuildings : []) {
            if (!needsSuggestion(building)) continue;
            try {
                const planned = context.planBuilding(building, {
                    turf, generator, rules, cache, owner: building, roads: null, storeyFallbackM, ...(region ? { region } : {}),
                    parcels: (typeof parcelsFor === 'function' && parcelsFor(building)) || [],
                    neighbours: (typeof neighbourPool === 'function' && neighbourPool(building)) || [],
                    heightM: typeof heightOf === 'function' ? heightOf(building) : heightOfBuilding(building)
                });
                for (const slice of planned.slices) {
                    out.push({ building, parcelId: slice.parcelId, footprint: slice.footprint,
                        floorPlans: (slice.result && slice.result.floorPlans) || null, warnings: (slice.result && slice.result.warnings) || [] });
                }
            } catch (error) {
                // A generator bug must not blank every other building: this one is flagged with the reason.
                out.push({ building, parcelId: (building.properties && building.properties.parcelId) ?? null,
                    footprint: { type: 'Feature', properties: {}, geometry: building.geometry }, floorPlans: null,
                    warnings: [{ code: 'layout-failed', severity: 'error', message: String((error && error.message) || error) }], error });
            }
        }
        return out;
    }

    // The style of a floorPlanToGeoJSON feature (its kind, and the opening type for openings) or of a
    // flagged footprint ({ kind: 'flagged' }). An unknown kind draws as slab.
    function styleKeyOf(properties) {
        const p = properties || {};
        if (p.kind === 'opening') return OPENING_STYLES[p.opening] || 'door';
        return Object.prototype.hasOwnProperty.call(STYLES, p.kind) ? p.kind : 'slab';
    }

    // Leaflet path options for a feature: the classes css/map.css colours, line weights and dashes, and,
    // when a palette is given, the same colours inline.
    function styleFor(feature, palette) {
        const key = styleKeyOf(feature && feature.properties);
        const style = STYLES[key];
        const options = { className: `cb-suggested-layout cb-suggested-layout--${key}`, ...style.options };
        if (style.stroke && palette && palette[style.stroke]) options.color = palette[style.stroke];
        if (style.fill && palette && palette[style.fill]) options.fillColor = palette[style.fill];
        return options;
    }

    // The palette roles from a CSS custom-property reader (name → value).
    function paletteFrom(readProperty) {
        const palette = {};
        for (const role of PALETTE_ROLES) {
            const value = String(readProperty(`--suggested-layout-${role}`) || '').trim();
            if (value) palette[role] = value;
        }
        return palette;
    }

    const GROUPED = { Polygon: 'MultiPolygon', MultiPolygon: 'MultiPolygon', LineString: 'MultiLineString', MultiLineString: 'MultiLineString' };
    // One feature per style, so a slice draws as a handful of SVG paths rather than one per wall piece
    // and opening (a 60 m slice has ~45 wall pieces and ~50 openings), stacked slab → walls → openings.
    function groupByStyle(collection) {
        const groups = new Map();
        for (const feature of (collection && collection.features) || []) {
            const geometry = feature && feature.geometry;
            const type = geometry && GROUPED[geometry.type];
            if (!type) continue;
            const key = styleKeyOf(feature.properties);
            if (!groups.has(key)) {
                const p = feature.properties || {};
                groups.set(key, { type: 'Feature', properties: { kind: p.kind, ...(p.opening ? { opening: p.opening } : {}), level: p.level, suggested: p.suggested === true },
                    geometry: { type, coordinates: [] } });
            }
            const group = groups.get(key);
            if (group.geometry.type !== type) throw new Error(`suggested-layouts-2d: style ${key} mixes ${group.geometry.type} and ${geometry.type}`);
            if (geometry.type === type) group.geometry.coordinates.push(...geometry.coordinates);
            else group.geometry.coordinates.push(geometry.coordinates);
        }
        const features = [...groups.entries()].sort((a, b) => DRAW_ORDER.indexOf(a[0]) - DRAW_ORDER.indexOf(b[0])).map(([, feature]) => feature);
        return { type: 'FeatureCollection', features };
    }

    // The flagged slice under a point ([lng, lat]), or null. Entries with a layout are not flagged.
    function flaggedAt(entries, lngLat, turf) {
        for (const entry of Array.isArray(entries) ? entries : []) {
            if (!entry || entry.floorPlans || !entry.footprint) continue;
            const box = entry.bbox || bboxOf(entry.footprint, turf);
            if (!box || lngLat[0] < box[0] || lngLat[0] > box[2] || lngLat[1] < box[1] || lngLat[1] > box[3]) continue;
            try { if (turf.booleanPointInPolygon(lngLat, entry.footprint)) return entry; } catch (_) { /* a degenerate footprint holds no point */ }
        }
        return null;
    }

    // What a flagged slice's tooltip says: the reasons it has no layout (errors), else every message.
    function tooltipLines(warnings) {
        const list = Array.isArray(warnings) ? warnings.filter(w => w && w.message) : [];
        const errors = list.filter(w => w.severity === 'error');
        return [...new Set((errors.length ? errors : list).map(w => String(w.message)))];
    }

    function requestedByUrl(search) {
        return new URLSearchParams(search || '').get(URL_FLAG) === '1';
    }

    // ---- Leaflet wiring (browser) ------------------------------------------------------------

    const state = { enabled: false, queued: false, group: null, renderer: null, cache: new Map(), flagged: [], drawn: 0, tooltip: null, hovered: null };

    function t(key, fallback) {
        const i18n = global.i18n;
        const value = i18n && typeof i18n.t === 'function' ? i18n.t(key) : null;
        return value && value !== key ? value : fallback;
    }
    const stamp = () => `[${new Date().toISOString()}] [suggested-layouts-2d]`;
    const describeBuilding = building => {
        const p = (building && building.properties) || {};
        return `${p.name || 'unnamed'} (proposal ${p.proposalId ?? '?'}, building ${p.buildingIndex ?? '?'})`;
    };

    function readPalette() {
        const doc = global.document;
        if (!doc || typeof global.getComputedStyle !== 'function') return {};
        const computed = global.getComputedStyle(doc.documentElement);
        return paletteFrom(name => computed.getPropertyValue(name));
    }

    function ensureLayer(map) {
        const pane = map.getPane(PANE) || map.createPane(PANE);
        pane.style.zIndex = PANE_Z_INDEX;
        pane.style.pointerEvents = 'none';
        if (!state.renderer) state.renderer = global.L.svg({ pane: PANE });
        if (!state.group) state.group = global.L.layerGroup();
        return state.group;
    }

    function hideTooltip() {
        state.hovered = null;
        const map = global.map;
        if (state.tooltip && map && map.hasLayer(state.tooltip)) map.removeLayer(state.tooltip);
    }

    // Flagged slices are not interactive (the parcel beneath keeps its clicks), so their reasons follow
    // the pointer instead: the map reports every move, and the slice under it is looked up.
    function onPointerMove(event) {
        const map = global.map;
        const hit = event && event.latlng ? flaggedAt(state.flagged, [event.latlng.lng, event.latlng.lat], global.turf) : null;
        const lines = hit ? tooltipLines(hit.warnings) : [];
        if (!lines.length) { hideTooltip(); return; }
        if (!state.tooltip) state.tooltip = global.L.tooltip({ className: 'cb-suggested-layout-tooltip', direction: 'top', offset: [0, -12], opacity: 1 });
        if (hit !== state.hovered) {
            const box = global.document.createElement('div');
            lines.forEach(line => {
                const row = global.document.createElement('div');
                row.textContent = line;
                box.appendChild(row);
            });
            state.tooltip.setContent(box);
            state.hovered = hit;
        }
        state.tooltip.setLatLng(event.latlng);
        if (!map.hasLayer(state.tooltip)) state.tooltip.addTo(map);
    }

    // Plans and draws what is in view. Cheap after the first time: plans are cached per slice content.
    function rebuild() {
        state.queued = false;
        const map = global.map, L = global.L, turf = global.turf;
        if (!state.enabled || !map || !state.group) return;
        state.group.clearLayers();
        state.flagged = [];
        state.drawn = 0;
        hideTooltip();
        if (!(map.getZoom() >= MIN_ZOOM)) return;
        const context = global.__defaultFloorPlanContext, generator = global.__defaultFloorPlans, plans = global.__buildingFloorPlans;
        if (!context || !generator || !plans) throw new Error('suggested-layouts-2d: building-floor-plans.js, default-floor-plans.js and default-floor-plan-context.js must load first');
        const view = map.getBounds().pad(VIEW_PAD);
        const bbox = [view.getWest(), view.getSouth(), view.getEast(), view.getNorth()];
        // Neighbours only matter near what is drawn: both pools are cut to the view once, not per building.
        const proposed = withinBbox(global.proposedBuildings, bbox, turf);
        const existing = withinBbox(global.buildingFeaturePool, bbox, turf);
        const fabric = global.LiveParcelFabric, cities = global.CityConfigManager;
        // The city's regulation preset (HR: NN 12/2023), as the context derives it from the city config.
        const region = typeof context.regionOf === 'function' && cities && typeof cities.getCurrentCityConfig === 'function'
            ? context.regionOf(cities.getCurrentCityConfig()) : null;
        const entries = collectLayouts({
            proposedBuildings: proposed, context, generator, turf, cache: state.cache, region,
            parcelsFor: feature => (fabric && typeof fabric.queryBounds === 'function' ? fabric.queryBounds(turf.bbox(feature), { includeCorridors: true }) : []),
            neighbourPool: feature => context.neighbourPool(feature, proposed, existing, turf),
            heightOf: feature => heightOfBuilding(feature, global.estimateBuildingHeightMeters),
            storeyFallbackM: global.STOREY_HEIGHT_M || 3.3
        });
        const palette = readPalette();
        const style = feature => styleFor(feature, palette);
        for (const entry of entries) {
            if (entry.error) console.error(`${stamp()} No layout for proposed building ${describeBuilding(entry.building)}`, entry.error);
            let data = null, shown = entry;
            if (entry.floorPlans) {
                try {
                    data = groupByStyle(plans.floorPlanToGeoJSON(entry.floorPlans, 0));
                } catch (error) {
                    console.error(`${stamp()} Could not draw the layout of ${describeBuilding(entry.building)}, parcel ${entry.parcelId}`, error);
                    shown = { ...entry, floorPlans: null, warnings: [{ code: 'layout-failed', severity: 'error', message: String((error && error.message) || error) }, ...entry.warnings] };
                }
            }
            if (!data) {
                data = { type: 'Feature', properties: { kind: 'flagged' }, geometry: shown.footprint.geometry };
                state.flagged.push({ ...shown, bbox: bboxOf(shown.footprint, turf) });
            }
            L.geoJSON(data, { pane: PANE, renderer: state.renderer, interactive: false, style }).addTo(state.group);
            state.drawn++;
        }
    }

    // A burst of updates (a proposal applying redraws building by building) is one rebuild.
    function scheduleRebuild() {
        if (!state.enabled || state.queued) return;
        state.queued = true;
        queueMicrotask(rebuild);
    }

    function syncToggle(on) {
        const box = global.document && typeof global.document.getElementById === 'function' ? global.document.getElementById(TOGGLE_ID) : null;
        if (box && box.checked !== on) box.checked = on;
    }

    function setEnabled(enabled) {
        const on = enabled === true;
        const map = global.map;
        if (!map || !global.L) throw new Error('suggested-layouts-2d: the map is not ready');
        syncToggle(on);
        if (on === state.enabled) return;
        state.enabled = on;
        if (on) {
            ensureLayer(map).addTo(map);
            map.on('moveend', scheduleRebuild);
            map.on('mousemove', onPointerMove);
            map.on('mouseout', hideTooltip);
            map.whenReady(rebuild);
        } else {
            map.off('moveend', scheduleRebuild);
            map.off('mousemove', onPointerMove);
            map.off('mouseout', hideTooltip);
            hideTooltip();
            state.group.clearLayers();
            map.removeLayer(state.group);
            state.flagged = [];
            state.drawn = 0;
        }
    }

    const snapshot = () => ({ enabled: state.enabled, drawn: state.drawn, flagged: state.flagged.length, cached: state.cache.size });

    // The Layers sheet row, beside "Show proposed buildings". index.html carries no markup for it: the
    // layer and its toggle arrive together. The change goes through toggleLayer like the other buildings.
    function installToggle(doc) {
        const existing = doc.getElementById(TOGGLE_ID);
        if (existing) return existing;
        const anchor = doc.getElementById('showProposedBuildings');
        const row = anchor && anchor.closest('label');
        if (!row || !row.parentNode) return null;
        const label = doc.createElement('label');
        label.setAttribute('data-i18n-key', 'sidebar.buildings.showSuggestedLayoutsTooltip');
        label.setAttribute('data-i18n-attr', 'title');
        label.title = t('sidebar.buildings.showSuggestedLayoutsTooltip',
            'Draw a suggested ground-floor layout inside each proposed building without a modelled interior. Red dashed outlines are too small for a minimum stair core. A suggestion, not part of the proposal.');
        const input = doc.createElement('input');
        input.type = 'checkbox';
        input.id = TOGGLE_ID;
        const text = doc.createElement('span');
        text.setAttribute('data-i18n-key', 'sidebar.buildings.showSuggestedLayouts');
        text.textContent = t('sidebar.buildings.showSuggestedLayouts', 'Suggested layouts (ground floor)');
        label.append(input, ' ', text);
        row.parentNode.insertBefore(label, row.nextSibling);
        input.addEventListener('change', () => {
            if (typeof global.toggleLayer === 'function') global.toggleLayer('suggestedLayouts');
            else setEnabled(input.checked);
        });
        return input;
    }

    function install() {
        const doc = global.document;
        const input = installToggle(doc);
        global.addEventListener('proposedBuildingsUpdated', scheduleRebuild);
        global.addEventListener('parcelFabricCommitted', scheduleRebuild);
        if (!requestedByUrl(global.location && global.location.search)) return;
        if (input && typeof global.toggleLayer === 'function') {
            input.checked = true;
            global.toggleLayer('suggestedLayouts');
        } else {
            setEnabled(true);
        }
    }

    const api = {
        MIN_ZOOM, URL_FLAG, STYLES, withinBbox, heightOfBuilding, collectLayouts, styleFor, paletteFrom, groupByStyle,
        flaggedAt, tooltipLines, requestedByUrl, setEnabled, isEnabled: () => state.enabled, rebuild, snapshot
    };
    global.__suggestedLayouts2D = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    const doc = global.document;
    if (doc && typeof doc.addEventListener === 'function' && typeof global.addEventListener === 'function') {
        if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', install, { once: true });
        else install();
    }
})(typeof window !== 'undefined' ? window : globalThis);
