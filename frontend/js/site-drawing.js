// The site tool (window.SiteTool): draw a proposal's SITE on the map — click corners, snap to parcel
// and existing-building outlines, edit vertices — and see its binding as you go: bound parcels outlined, parcels reached into
// by under half a metre flagged with the width, open ground hatched, a coverage label; a preview over
// the loaded parcels first (labelled), then the server's answer (POST /proposals/binding). From the
// site panel the build palette creates on the site: structures use it directly, a block uses it as
// its superparcel, detached and row houses cut synthetic plots along a frontage edge
// (proposals/site-plots.js). The pure halves are proposals/site-draft.js and site-binding.js; the
// map interaction reuses PolygonGeometryEditor. PARCEL-OPTIONAL.md, phase 2.
(function (win) {
    'use strict';

    const doc = win.document;
    const PANE = 'siteToolPane';
    const LOCK_OWNER = 'site-tool';
    const CLOSE_PX = 12;
    // A preview binds at most this many loaded parcels (each needs an intrusion measurement).
    const PREVIEW_PARCEL_CAP = 250;
    const HATCH_ID = 'site-open-ground-hatch';
    // Building outlines kept as snap targets: those in the viewport, at most this many.
    const BUILDING_SNAP_CAP = 5000;

    const state = {
        phase: 'idle', // idle | drawing | editing | plots
        ring: [],
        site: null,
        siteError: null,
        toleranceM: 0,
        preview: null,
        previewParcels: new Map(), // cadastral id -> geometry, the parcels the preview used
        previewSkipped: false,
        openGround: null,
        server: null,
        serverError: null,
        serverPending: false,
        serverSeq: 0,
        selectionIds: [],
        ground: null,
        editor: null,
        group: null,
        renderer: null,
        drawingLayers: null,
        panel: null,
        paletteOpen: false,
        plotTool: null,
        frontageIndex: null,
        plots: [],
        synthetic: new Map(),
        buildingTargets: null, // snap entries of the building outlines in the viewport (null = stale)
        snapKind: null,
        frontageBasis: null, // how the frontage was chosen: { basis: 'street'|'longest'|'user'|'pending', ... }
        frontageSeq: 0,
        mapWired: false
    };

    // ---- small helpers ----

    const t = (key, fallback, params) => {
        const i18n = win.i18n;
        if (i18n && typeof i18n.t === 'function') {
            const value = i18n.t(key, params || {});
            if (typeof value === 'string' && value && value !== key) return value;
        }
        if (!params) return fallback;
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (name in params ? params[name] : match));
    };
    const log = (...args) => console.info(`[${new Date().toISOString()}] [SiteTool]`, ...args);
    const escapeHtml = value => String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const draftApi = () => win.__siteDraft;
    const bindingApi = () => win.__siteBinding;
    const isActive = () => state.phase !== 'idle';
    const map = () => win.map;

    function cityId() {
        const manager = win.CityConfigManager;
        if (manager && typeof manager.getCurrentCityId === 'function') return manager.getCurrentCityId();
        return typeof win.getProposalCityId === 'function' ? win.getProposalCityId() : null;
    }

    function cityHasCadastre() {
        const manager = win.CityConfigManager;
        return !(manager && typeof manager.hasParcelData === 'function' && !manager.hasParcelData());
    }

    function backendBase() {
        if (typeof win.resolveBackendBaseUrl === 'function') return win.resolveBackendBaseUrl();
        if (typeof win.getBackendBase === 'function') return win.getBackendBase();
        throw new Error('SiteTool: the backend base URL is unavailable');
    }

    function metresPerPixel(lat) {
        const zoom = map().getZoom();
        return 40075016.686 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom + 8);
    }

    // ---- ground near the site ----

    // Live parcel features near a bbox [w, s, e, n] (corridors included: streets are parcels too).
    function liveParcelsNear(box) {
        const fabric = win.LiveParcelFabric;
        if (!fabric || typeof fabric.queryBounds !== 'function') return [];
        return fabric.queryBounds(box, { includeCorridors: true }) || [];
    }

    // The CADASTRAL parcels (immutable repository facts, cadastral ids) under the live pieces near
    // a bbox: what the binding is about, whatever the plan has done to the fabric since.
    function cadastralParcelsNear(box) {
        const fabric = win.LiveParcelFabric;
        const repository = win.CadastralParcelRepository;
        const ids = new Set();
        liveParcelsNear(box).forEach(feature => {
            // A piece on open ground stands on no cadastral parcel: it adds nothing to bind.
            if (win.__openGround && win.__openGround.isGroundPiece(feature)) return;
            const anchors = fabric && typeof fabric.explicitCadastreIds === 'function' ? fabric.explicitCadastreIds(feature) : [];
            (anchors && anchors.length ? anchors : [fabric.featureId(feature)]).forEach(id => { if (id) ids.add(String(id)); });
        });
        if (!ids.size || !repository || typeof repository.peekMany !== 'function') return [];
        let features = [];
        try { features = repository.peekMany(Array.from(ids)); } catch (error) {
            console.warn('[SiteTool] cadastral lookup failed', error);
            features = [];
        }
        return features
            .map(feature => ({ id: String(feature.properties?.parcelId ?? fabric.featureId(feature)), geometry: feature.geometry }))
            .filter(parcel => parcel.id && parcel.geometry);
    }

    function boxAround(coordinate, radiusM) {
        const dLat = radiusM / 111320;
        const dLng = radiusM / (111320 * Math.cos(coordinate[1] * Math.PI / 180));
        return [coordinate[0] - dLng, coordinate[1] - dLat, coordinate[0] + dLng, coordinate[1] + dLat];
    }

    // The existing-building layers drawn on the map right now (GDI or the city's provider, DGU, OSM):
    // whatever the Layers sheet has on. Their features are already in memory; nothing is fetched.
    function shownBuildingLayers() {
        return [win.buildingLayer, win.dguBuildingLayer, win.osmBuildingLayer]
            .filter((layer, index, all) => layer && all.indexOf(layer) === index && typeof layer.eachLayer === 'function' && map().hasLayer(layer));
    }

    // Snap entries for the building outlines in the viewport, rebuilt lazily after the map moves or a
    // building layer changes. A building the plan destroyed is not there any more: it is skipped.
    function buildingSnapTargets() {
        if (state.buildingTargets) return state.buildingTargets;
        const geometries = [];
        shownBuildingLayers().forEach(layer => layer.eachLayer(item => {
            const feature = item && item.feature;
            if (!feature || !feature.geometry) return;
            if (feature.properties && feature.properties.__outcome === 'destroyed') return;
            geometries.push(feature.geometry);
        }));
        const bounds = map().getBounds();
        const box = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
        state.buildingTargets = draftApi().snapTargetsInBox(geometries, box, { cap: BUILDING_SNAP_CAP });
        log(`building snap targets: ${state.buildingTargets.length} outlines in view (of ${geometries.length} loaded)`);
        return state.buildingTargets;
    }

    function invalidateBuildingTargets() {
        state.buildingTargets = null;
    }

    // A building layer shown, hidden or replaced (DGU/OSM refetches swap the whole GeoJSON group);
    // the tool's own layers live in its pane and never count.
    function onMapLayerChange(event) {
        const layer = event && event.layer;
        if (!layer || !(layer instanceof win.L.GeoJSON)) return;
        if (layer.options && layer.options.pane === PANE) return;
        invalidateBuildingTargets();
    }

    // Snap a coordinate to the nearest parcel or building corner, else edge, within SNAP_RADIUS_PX
    // (Alt disables). The result's `kind` says which outline it landed on.
    function snap(coordinate, event) {
        if (event && event.originalEvent && event.originalEvent.altKey) return { coordinate, snapped: false };
        const radiusM = draftApi().SNAP_RADIUS_PX * metresPerPixel(coordinate[1]);
        const parcels = liveParcelsNear(boxAround(coordinate, radiusM)).map(feature => feature.geometry);
        return draftApi().snapToGround(coordinate, { parcels, buildings: buildingSnapTargets() }, { radiusM });
    }

    function snapLabel(snapped) {
        const building = snapped.kind === 'building';
        if (snapped.snapped === 'vertex') {
            return building ? t('siteTool.snap.buildingCorner', 'Building corner') : t('siteTool.snap.parcelCorner', 'Parcel corner');
        }
        return building ? t('siteTool.snap.buildingEdge', 'Building edge') : t('siteTool.snap.parcelEdge', 'Parcel edge');
    }

    // ---- synthetic design parcels (the site as a superparcel, plots cut from it) ----

    function siteKey() {
        const text = JSON.stringify(state.site || state.ring);
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
        return (hash >>> 0).toString(36);
    }

    function syntheticFeature(id, geometry, extra) {
        const area = win.turf ? win.turf.area({ type: 'Feature', properties: {}, geometry }) : null;
        return {
            type: 'Feature',
            id,
            properties: { parcelId: id, id, calculatedArea: area, synthetic: true, siteParcel: true, ...(extra || {}) },
            geometry
        };
    }

    function resolveDesignParcelFeature(id) {
        const key = String(id || '');
        if (state.synthetic.has(key)) return JSON.parse(JSON.stringify(state.synthetic.get(key)));
        return win.LiveParcelFabric && typeof win.LiveParcelFabric.get === 'function' ? win.LiveParcelFabric.get(key) : null;
    }

    // ---- map layers ----

    function ensurePane() {
        const m = map();
        let pane = m.getPane(PANE);
        if (!pane) {
            pane = m.createPane(PANE);
            pane.classList.add('site-tool-pane');
        }
        if (!state.renderer) state.renderer = win.L.svg({ pane: PANE });
        return pane;
    }

    function ensureHatchPattern() {
        const svg = state.renderer && state.renderer._container;
        if (!svg || svg.querySelector(`#${HATCH_ID}`)) return;
        const ns = 'http://www.w3.org/2000/svg';
        const defs = doc.createElementNS(ns, 'defs');
        const pattern = doc.createElementNS(ns, 'pattern');
        pattern.setAttribute('id', HATCH_ID);
        pattern.setAttribute('patternUnits', 'userSpaceOnUse');
        pattern.setAttribute('width', '8');
        pattern.setAttribute('height', '8');
        pattern.setAttribute('patternTransform', 'rotate(45)');
        const line = doc.createElementNS(ns, 'line');
        line.setAttribute('x1', '0'); line.setAttribute('y1', '0');
        line.setAttribute('x2', '0'); line.setAttribute('y2', '8');
        line.setAttribute('class', 'site-open-ground-hatch-line');
        pattern.appendChild(line);
        defs.appendChild(pattern);
        svg.insertBefore(defs, svg.firstChild);
    }

    function clearLayers() {
        if (state.group) {
            try { map().removeLayer(state.group); } catch (_) { }
        }
        state.group = null;
    }

    function geoLayer(geometry, className, extra) {
        return win.L.geoJSON({ type: 'Feature', properties: {}, geometry }, {
            pane: PANE,
            renderer: state.renderer,
            interactive: false,
            style: () => Object.assign({ className, weight: 2 }, extra || {})
        });
    }

    function renderLayers() {
        clearLayers();
        if (!isActive() || !map()) return;
        ensurePane();
        const group = win.L.layerGroup().addTo(map());
        state.group = group;
        const warnings = summary() ? summary().warnings : [];
        const warned = new Set(warnings.map(w => w.parcelId));
        const bound = new Set(((state.server || state.preview || {}).parcels || []).map(hit => String(hit.parcelId)));
        state.previewParcels.forEach((geometry, id) => {
            if (warned.has(id)) {
                const warning = warnings.find(w => w.parcelId === id);
                geoLayer(geometry, `site-binding-parcel site-binding-parcel--warn site-binding-parcel--${warning.kind}`)
                    .bindTooltip(warningText(warning), { sticky: true })
                    .addTo(group);
            } else if (bound.has(id)) {
                geoLayer(geometry, 'site-binding-parcel site-binding-parcel--bound').addTo(group);
            }
        });
        if (state.openGround) geoLayer(state.openGround, 'site-open-ground').addTo(group);
        if (state.site) geoLayer(state.site, `site-outline site-outline--${state.phase}`).addTo(group);
        if (state.phase === 'plots') renderPlots(group);
        if (state.phase === 'drawing') renderDrawing(group);
        ensureHatchPattern();
    }

    function renderDrawing(group) {
        const latlngs = state.ring.map(([lng, lat]) => [lat, lng]);
        if (latlngs.length >= 2) {
            win.L.polyline(latlngs, { pane: PANE, renderer: state.renderer, className: 'site-drawing-line', interactive: false }).addTo(group);
        }
        latlngs.forEach((latlng, index) => {
            win.L.circleMarker(latlng, {
                pane: PANE, renderer: state.renderer, radius: index === 0 ? 7 : 5,
                className: index === 0 ? 'site-drawing-vertex site-drawing-vertex--first' : 'site-drawing-vertex',
                interactive: false
            }).addTo(group);
        });
    }

    function renderPlots(group) {
        state.plots.forEach(plot => geoLayer(plot.geometry, 'site-plot').addTo(group));
        const edges = win.__sitePlots ? win.__sitePlots.frontageEdges(state.site) : [];
        edges.forEach(edge => {
            const chosen = edge.index === state.frontageIndex;
            const line = win.L.polyline([[edge.a[1], edge.a[0]], [edge.b[1], edge.b[0]]], {
                pane: PANE, renderer: state.renderer,
                className: chosen ? 'site-frontage-edge site-frontage-edge--chosen' : 'site-frontage-edge',
                interactive: true, bubblingMouseEvents: false
            }).addTo(group);
            line.bindTooltip(chosen
                ? t('siteTool.plots.frontageChosen', 'Frontage edge')
                : t('siteTool.plots.frontagePick', 'Click to use this edge as the frontage'), { sticky: true });
            line.on('click', event => {
                if (event && event.originalEvent) win.L.DomEvent.stop(event.originalEvent);
                state.frontageIndex = edge.index;
                state.frontageBasis = { basis: 'user' };
                state.frontageSeq += 1; // a street answer still in flight must not undo the choice
                cutPlots();
                renderLayers();
                renderPanel();
            });
        });
    }

    // ---- binding ----

    function summary() {
        const binding = state.server || state.preview;
        return binding ? draftApi().bindingSummary(binding) : null;
    }

    function computePreview() {
        state.preview = null;
        state.openGround = null;
        state.previewParcels = new Map();
        state.previewSkipped = false;
        if (!state.site || !win.turf) return;
        if (!cityHasCadastre()) {
            state.preview = bindingApi().bindingFromParcels(state.site, [], { toleranceM: state.toleranceM, regionHasCadastre: false });
            state.openGround = state.site;
            return;
        }
        const parcels = cadastralParcelsNear(win.turf.bbox(state.site));
        if (parcels.length > PREVIEW_PARCEL_CAP) {
            state.previewSkipped = true;
            log(`preview skipped: ${parcels.length} parcels near the site (cap ${PREVIEW_PARCEL_CAP})`);
            return;
        }
        const started = performance.now();
        state.preview = bindingApi().bindingFromParcels(state.site, parcels, { toleranceM: state.toleranceM });
        const touching = new Set(state.preview.parcels.concat(state.preview.touched).map(hit => String(hit.parcelId)));
        parcels.forEach(parcel => { if (touching.has(parcel.id)) state.previewParcels.set(parcel.id, parcel.geometry); });
        state.openGround = draftApi().openGroundOf(state.site, parcels, { toleranceM: state.toleranceM });
        log(`preview: ${state.preview.parcels.length} bound, ${state.preview.touched.length} touched, coverage ${state.preview.coverage} over ${parcels.length} loaded parcels in ${Math.round(performance.now() - started)} ms`);
    }

    function requestServerBinding() {
        const seq = ++state.serverSeq;
        state.server = null;
        state.serverError = null;
        if (!state.site || !win.__publishBinding) return;
        state.serverPending = true;
        const fetchBinding = win.__publishBinding.createFetchBinding(win.fetch.bind(win), backendBase());
        fetchBinding({ site: state.site, toleranceM: state.toleranceM, city: cityId() })
            .then(binding => {
                if (seq !== state.serverSeq) return;
                state.server = binding;
                log(`server binding: ${binding.parcels.length} bound, coverage ${binding.coverage}${binding.reason ? ` (${binding.reason})` : ''}`);
            })
            .catch(error => {
                if (seq !== state.serverSeq) return;
                state.serverError = error && error.message ? error.message : String(error);
                console.warn(`[${new Date().toISOString()}] [SiteTool] server binding failed`, error);
            })
            .finally(() => {
                if (seq !== state.serverSeq) return;
                state.serverPending = false;
                renderLayers();
                renderPanel();
            });
    }

    // The site changed (drawn, a vertex moved, a parcel included or trimmed).
    function siteChanged(options = {}) {
        const result = draftApi().siteFromRing(state.ring);
        state.site = result.ok ? result.site : null;
        state.siteError = result.ok ? null : result.reason;
        state.plots = [];
        computePreview();
        if (options.server !== false && state.site) requestServerBinding();
        else { state.serverSeq += 1; state.server = null; state.serverPending = false; }
        renderLayers();
        renderPanel();
    }

    // ---- drawing ----

    function onMapClick(event) {
        if (state.phase !== 'drawing' || !event || !event.latlng) return;
        const raw = [event.latlng.lng, event.latlng.lat];
        if (state.ring.length >= 3) {
            const first = map().latLngToContainerPoint([state.ring[0][1], state.ring[0][0]]);
            const here = map().latLngToContainerPoint(event.latlng);
            if (first.distanceTo(here) <= CLOSE_PX) { finishDrawing(); return; }
        }
        const snapped = snap(raw, event);
        const last = state.ring[state.ring.length - 1];
        if (last) {
            const lastPoint = map().latLngToContainerPoint([last[1], last[0]]);
            const herePoint = map().latLngToContainerPoint([snapped.coordinate[1], snapped.coordinate[0]]);
            if (lastPoint.distanceTo(herePoint) < 3) return; // a double click, not a new corner
        }
        state.ring.push(snapped.coordinate);
        renderLayers();
        renderPanel();
    }

    function onMapMouseMove(event) {
        if (state.phase !== 'drawing' || !event || !event.latlng) return;
        const snapped = snap([event.latlng.lng, event.latlng.lat], event);
        if (!snapped.snapped) { removeSnapMarker(); return; }
        const latlng = [snapped.coordinate[1], snapped.coordinate[0]];
        // The marker and its label say what the corner will land on (parcel or building, corner or edge).
        const kind = `${snapped.kind}-${snapped.snapped}`;
        if (state.snapMarker && state.snapKind !== kind) removeSnapMarker();
        if (!state.snapMarker) {
            ensurePane();
            state.snapMarker = win.L.circleMarker(latlng, {
                pane: PANE, renderer: state.renderer, radius: 6,
                className: `site-snap-marker site-snap-marker--${snapped.kind}`, interactive: false
            }).addTo(map());
            state.snapMarker.bindTooltip(snapLabel(snapped), {
                permanent: true, direction: 'right', offset: [8, 0], className: `site-snap-label site-snap-label--${snapped.kind}`
            });
            state.snapKind = kind;
        } else state.snapMarker.setLatLng(latlng);
    }

    function removeSnapMarker() {
        if (state.snapMarker) { try { map().removeLayer(state.snapMarker); } catch (_) { } }
        state.snapMarker = null;
        state.snapKind = null;
    }

    function onKeyDown(event) {
        if (doc.body.classList.contains('three-mode-active')) return;
        if (!isActive() || event.defaultPrevented) return;
        if (typeof win.isEditableTarget === 'function' && win.isEditableTarget(event.target)) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            if (state.phase === 'plots') { leavePlots(); return; }
            cancel();
        } else if (event.key === 'Enter' && state.phase === 'drawing') {
            event.preventDefault();
            finishDrawing();
        } else if (event.key === 'Backspace' && state.phase === 'drawing' && state.ring.length) {
            event.preventDefault();
            state.ring.pop();
            renderLayers();
            renderPanel();
        }
    }

    function wireMap() {
        if (state.mapWired) return;
        state.mapWired = true;
        map().on('click', onMapClick);
        map().on('mousemove', onMapMouseMove);
        map().on('moveend', invalidateBuildingTargets);
        map().on('layeradd layerremove', onMapLayerChange);
        win.addEventListener('buildingsLayerUpdated', invalidateBuildingTargets);
        doc.addEventListener('keydown', onKeyDown);
    }

    function unwireMap() {
        if (!state.mapWired) return;
        state.mapWired = false;
        map().off('click', onMapClick);
        map().off('mousemove', onMapMouseMove);
        map().off('moveend', invalidateBuildingTargets);
        map().off('layeradd layerremove', onMapLayerChange);
        win.removeEventListener('buildingsLayerUpdated', invalidateBuildingTargets);
        doc.removeEventListener('keydown', onKeyDown);
        removeSnapMarker();
        invalidateBuildingTargets();
    }

    function finishDrawing() {
        const result = draftApi().siteFromRing(state.ring);
        if (!result.ok) {
            state.siteError = result.reason;
            renderPanel();
            return;
        }
        beginEditing(state.ring);
    }

    function beginEditing(ring) {
        state.phase = 'editing';
        state.ring = draftApi().openRing(ring);
        doc.body.classList.remove('site-tool-drawing');
        destroyEditor();
        state.editor = win.PolygonGeometryEditor.create({
            map: map(),
            leaflet: win.L,
            turf: win.turf,
            ring: state.ring,
            vertexTitle: t('siteTool.editor.vertexTitle', 'Drag to move · click an edge to add a corner'),
            deleteTitle: t('siteTool.editor.deleteVertex', 'Delete this corner'),
            undoTitle: t('siteTool.editor.undo', 'Undo (Cmd/Ctrl+Z)'),
            snapCoordinate: coordinate => snap(coordinate, null).coordinate,
            onCommit: ({ ring: next }) => {
                state.ring = next;
                siteChanged();
            }
        });
        siteChanged();
    }

    function destroyEditor() {
        if (state.editor) { try { state.editor.destroy(); } catch (_) { } }
        state.editor = null;
    }

    // ---- include / trim a flagged parcel ----

    function outerRingOf(geometry) {
        const g = geometry && geometry.type === 'Feature' ? geometry.geometry : geometry;
        if (!g) return null;
        if (g.type === 'Polygon') return g.coordinates[0];
        if (g.type === 'MultiPolygon' && g.coordinates.length === 1) return g.coordinates[0][0];
        return null;
    }

    function reshapeWith(parcelId, operation) {
        const geometry = state.previewParcels.get(parcelId);
        if (!geometry || !state.site) return;
        let next = null;
        try {
            const siteFeature = win.turf.feature(state.site);
            const parcelFeature = win.turf.feature(geometry);
            next = operation === 'include' ? win.turf.union(siteFeature, parcelFeature) : win.turf.difference(siteFeature, parcelFeature);
        } catch (error) {
            console.warn('[SiteTool] reshape failed', error);
        }
        const ring = next ? outerRingOf(next.geometry) : null;
        if (!ring) {
            notify(t('siteTool.errors.reshapeSplit', 'That would split the site in two; edit its corners instead.'), 'error');
            return;
        }
        log(`${operation} ${parcelId}: site ring ${state.ring.length} -> ${ring.length - 1} vertices`);
        state.ring = draftApi().openRing(ring);
        if (state.editor) { state.editor.ring = state.ring.slice(); state.editor.render({ refreshRing: false }); }
        siteChanged();
    }

    function notify(message, kind) {
        if (typeof win.showEphemeralMessage === 'function') win.showEphemeralMessage(message, 6000, kind || 'info');
        if (typeof win.updateStatus === 'function') win.updateStatus(message);
    }

    // ---- panel ----

    function ensurePanel() {
        if (state.panel) return state.panel;
        const host = doc.getElementById('map-container') || doc.body;
        const panel = doc.createElement('section');
        panel.id = 'site-panel';
        panel.className = 'site-panel';
        panel.setAttribute('role', 'region');
        panel.addEventListener('click', onPanelClick);
        host.appendChild(panel);
        state.panel = panel;
        return panel;
    }

    function coverageText(sum) {
        const prefix = sum.isPreview ? t('siteTool.binding.previewPrefix', 'Preview') : t('siteTool.binding.serverPrefix', 'Cadastre');
        const labels = {
            complete: t('siteTool.coverage.complete', 'complete — the whole site lies on cadastral parcels'),
            partial: t('siteTool.coverage.partial', 'partial — part of the site is open ground (no parcel)'),
            none: t('siteTool.coverage.none', 'none — no parcels here; the whole site is open ground'),
            unknown: t('siteTool.coverage.unknown', 'unknown — can\'t check parcels here')
        };
        if (sum.coverage === 'partial' && sum.allOpen) {
            return `${prefix}: ${t('siteTool.coverage.partialAll', 'partial — the whole site is open ground: no parcel here, though the cadastre covers the area')}`;
        }
        return `${prefix}: ${labels[sum.coverage] || labels.unknown}`;
    }

    function warningText(warning) {
        return warning.kind === 'touched'
            ? t('siteTool.binding.touched', 'Reaches {{width}} into {{parcel}} — below the tolerance, not bound.', { width: warning.width, parcel: warning.parcelId })
            : t('siteTool.binding.smallIntrusion', 'Reaches {{width}} into {{parcel}} — include it, or change the design.', { width: warning.width, parcel: warning.parcelId });
    }

    function areaText() {
        if (!state.site) return '';
        const area = draftApi().siteAreaM2(state.site);
        return CbFormat.formatArea(area);
    }

    function hintText() {
        if (state.phase === 'drawing') {
            return t('siteTool.hint.drawing', 'Click to add corners (they snap to parcel and building outlines; hold Alt not to). Click the first corner or press Enter to finish. Backspace removes the last corner, Esc cancels.');
        }
        if (state.phase === 'plots') {
            return t('siteTool.hint.plots', 'Plots are cut along the frontage edge (by default the one facing a street, else the longest). Click another edge of the site to use it instead.');
        }
        return t('siteTool.hint.editing', 'Drag corners to reshape, click an edge to add one. Then build on the site.');
    }

    function siteErrorText(reason) {
        const map = {
            'too-few-vertices': t('siteTool.errors.tooFew', 'A site needs at least three corners.'),
            'too-many-vertices': t('siteTool.errors.tooMany', 'A site can have at most 500 corners.'),
            'self-intersecting': t('siteTool.errors.selfIntersecting', 'The outline crosses itself; move a corner so it does not.'),
            'too-small': t('siteTool.errors.tooSmall', 'The site is too small.')
        };
        return map[reason] || reason;
    }

    function bindingHtml() {
        if (state.phase === 'drawing' || !state.site) return '';
        const sum = summary();
        const parts = [];
        if (state.previewSkipped && !state.server) {
            parts.push(`<p class="site-panel__note">${escapeHtml(t('siteTool.binding.previewSkipped', 'Too many parcels around this site for a preview; waiting for the server.'))}</p>`);
        }
        if (sum) {
            parts.push(`<p class="site-panel__coverage site-panel__coverage--${sum.coverage}">${escapeHtml(coverageText(sum))}</p>`);
            const bound = sum.bound.map(hit => hit.parcelId);
            if (bound.length) {
                const shown = bound.slice(0, 8).map(escapeHtml).join(', ');
                const more = bound.length > 8 ? ` ${escapeHtml(t('siteTool.binding.more', '+{{count}} more', { count: bound.length - 8 }))}` : '';
                parts.push(`<p class="site-panel__bound">${escapeHtml(t('siteTool.binding.bound', 'Bound parcels ({{count}}):', { count: bound.length }))} ${shown}${more}</p>`);
            } else if (sum.coverage !== 'unknown') {
                parts.push(`<p class="site-panel__bound">${escapeHtml(t('siteTool.binding.noParcels', 'Binds no parcel: it can only execute through an authority\'s verdict.'))}</p>`);
            }
            if (sum.openGround && sum.coverage !== 'none') {
                parts.push(`<p class="site-panel__note">${escapeHtml(t('siteTool.binding.openGround', 'Hatched: open ground nobody can consent for; executing needs an authority\'s verdict.'))}</p>`);
            }
            if (sum.warnings.length) {
                const items = sum.warnings.map(warning => {
                    const canReshape = state.previewParcels.has(warning.parcelId);
                    return `<li class="site-panel__warning site-panel__warning--${warning.kind}">
                        <span>${escapeHtml(warningText(warning))}</span>
                        ${canReshape ? `<span class="site-panel__warning-actions">
                            <button type="button" class="site-panel__mini" data-site-include="${escapeHtml(warning.parcelId)}">${escapeHtml(t('siteTool.binding.include', 'Include it'))}</button>
                            <button type="button" class="site-panel__mini" data-site-trim="${escapeHtml(warning.parcelId)}">${escapeHtml(t('siteTool.binding.trim', 'Trim the site'))}</button>
                        </span>` : ''}
                    </li>`;
                }).join('');
                parts.push(`<ul class="site-panel__warnings">${items}</ul>`);
            }
        }
        const status = state.serverPending
            ? t('siteTool.binding.checking', 'Checking with the cadastre…')
            : (state.serverError
                ? t('siteTool.binding.serverFailed', 'Could not check with the server: {{reason}}', { reason: state.serverError })
                : (state.server ? (state.server.coverage === 'none'
                    ? t('siteTool.binding.serverNoCadastre', 'Confirmed by the server: no cadastre covers this place.')
                    : t('siteTool.binding.serverChecked', 'Checked against the full cadastre.'))
                    : t('siteTool.binding.previewOnly', 'Preview from the parcels loaded on the map.')));
        parts.push(`<p class="site-panel__status">${escapeHtml(status)}</p>`);
        return parts.join('');
    }

    // A site with open ground is subdivided (PARCEL-OPTIONAL.md phase 4): the readjustment editor
    // with the site as its pool, the bound parcels' owners contributing their part and the open
    // ground contributing area with no owner. A site wholly over parcels stays a readjustment of
    // selected parcels; a site where the server holds no cadastre cannot tell owned from open.
    function subdividable() {
        const sum = summary();
        return !!(sum && sum.openGround && sum.coverage !== 'unknown');
    }

    // Why a tool cannot run on this site, keyed by tool (the palette shows them disabled).
    function disabledTools() {
        const sum = summary();
        if (subdividable()) return {};
        const reason = (sum && sum.coverage === 'unknown')
            ? t('siteTool.palette.readjustUnknownCadastre', 'Subdividing needs a cadastre the server holds: this place has none it knows.')
            : t('siteTool.palette.readjustNeedsParcels', 'Land readjustment works on selected parcels: select them instead of drawing a site.');
        return { reparcellization: reason };
    }

    function paletteHtml() {
        if (typeof win.buildProposalPaletteHtml !== 'function') return '';
        return win.buildProposalPaletteHtml({
            buildHandler: 'SiteTool.build',
            transportHandler: 'SiteTool.transport',
            includeOwnership: false,
            disabled: disabledTools(),
            labels: subdividable() ? { reparcellization: t('siteTool.palette.subdivide', 'Subdivide') } : {}
        });
    }

    function plotsHtml() {
        const tool = state.plotTool === 'row'
            ? t('panel.parcel.build.row', 'Row houses') : t('panel.parcel.build.parcelBased', 'Detached');
        const edges = win.__sitePlots ? win.__sitePlots.frontageEdges(state.site) : [];
        const edge = edges.find(e => e.index === state.frontageIndex);
        const basis = win.StreetFrontage ? win.StreetFrontage.basisText(state.frontageBasis) : '';
        return `
            <p class="site-panel__note">${escapeHtml(t('siteTool.plots.summary', '{{tool}}: plots {{count}}, along a {{length}} m frontage.', {
                tool, count: state.plots.length, length: edge ? Math.round(edge.lengthM) : 0
            }))}</p>
            ${basis ? `<p class="site-panel__note site-panel__frontage site-panel__frontage--${escapeHtml(state.frontageBasis.basis)}">${escapeHtml(basis)}</p>` : ''}
            <div class="site-panel__actions">
                <button type="button" class="site-panel__btn site-panel__btn--primary" data-site-action="plots-continue" ${state.plots.length ? '' : 'disabled'}>${escapeHtml(t('siteTool.plots.continue', 'Design on these plots'))}</button>
                <button type="button" class="site-panel__btn" data-site-action="plots-back">${escapeHtml(t('siteTool.plots.back', 'Back'))}</button>
            </div>`;
    }

    function renderPanel() {
        if (!isActive()) { if (state.panel) state.panel.hidden = true; return; }
        const panel = ensurePanel();
        panel.hidden = false;
        panel.setAttribute('aria-label', t('siteTool.title', 'Site'));
        const closeLabel = t('modal.common.close', 'Close');
        const actions = [];
        if (state.phase === 'drawing') {
            actions.push(`<button type="button" class="site-panel__btn site-panel__btn--primary" data-site-action="finish" ${state.ring.length >= 3 ? '' : 'disabled'}>${escapeHtml(t('siteTool.actions.finish', 'Finish site'))}</button>`);
            actions.push(`<button type="button" class="site-panel__btn" data-site-action="undo" ${state.ring.length ? '' : 'disabled'}>${escapeHtml(t('siteTool.actions.undoCorner', 'Remove last corner'))}</button>`);
        } else if (state.phase === 'editing') {
            actions.push(`<button type="button" class="site-panel__btn site-panel__btn--primary" data-site-action="palette" ${state.site ? '' : 'disabled'} aria-expanded="${state.paletteOpen}">${escapeHtml(t('siteTool.actions.build', 'Build on this site'))}</button>`);
            actions.push(`<button type="button" class="site-panel__btn" data-site-action="redraw">${escapeHtml(t('siteTool.actions.redraw', 'Redraw'))}</button>`);
        }
        actions.push(`<button type="button" class="site-panel__btn" data-site-action="cancel">${escapeHtml(t('siteTool.actions.cancel', 'Cancel'))}</button>`);
        const title = state.phase === 'drawing' ? t('siteTool.titleDrawing', 'Draw a site') : t('siteTool.title', 'Site');
        panel.innerHTML = `
            <div class="site-panel__head">
                <h3 class="site-panel__title">${escapeHtml(title)}</h3>
                <span class="site-panel__area">${escapeHtml(areaText())}</span>
                <button type="button" class="close-circle-btn site-panel__close" data-site-action="cancel" aria-label="${escapeHtml(closeLabel)}" title="${escapeHtml(closeLabel)}">×</button>
            </div>
            <p class="site-panel__hint">${escapeHtml(hintText())}</p>
            ${state.siteError && state.phase !== 'drawing' ? `<p class="site-panel__error">${escapeHtml(siteErrorText(state.siteError))}</p>` : ''}
            ${state.siteError && state.phase === 'drawing' && state.ring.length >= 3 ? `<p class="site-panel__error">${escapeHtml(siteErrorText(state.siteError))}</p>` : ''}
            <div class="site-panel__binding">${bindingHtml()}</div>
            ${state.phase === 'plots' ? plotsHtml() : `<div class="site-panel__actions">${actions.join('')}</div>`}
            ${state.phase === 'editing' && state.paletteOpen && state.site ? `<div class="site-panel__palette">${paletteHtml()}</div>` : ''}`;
    }

    function onPanelClick(event) {
        const include = event.target.closest('[data-site-include]');
        if (include) { reshapeWith(include.getAttribute('data-site-include'), 'include'); return; }
        const trim = event.target.closest('[data-site-trim]');
        if (trim) { reshapeWith(trim.getAttribute('data-site-trim'), 'trim'); return; }
        const button = event.target.closest('[data-site-action]');
        if (!button || button.disabled) return;
        const action = button.getAttribute('data-site-action');
        if (action === 'finish') finishDrawing();
        else if (action === 'undo') { state.ring.pop(); renderLayers(); renderPanel(); }
        else if (action === 'palette') { state.paletteOpen = !state.paletteOpen; renderPanel(); }
        else if (action === 'redraw') redraw();
        else if (action === 'cancel') cancel();
        else if (action === 'plots-continue') continueWithPlots();
        else if (action === 'plots-back') leavePlots();
    }

    // ---- building on the site ----

    function siteContext() {
        return {
            site: JSON.parse(JSON.stringify(state.site)),
            toleranceM: state.toleranceM,
            binding: JSON.parse(JSON.stringify(state.server || state.preview || null)),
            selectionIds: state.selectionIds.slice()
        };
    }

    const STRUCTURES = ['park', 'square', 'lake'];

    function build(toolKey) {
        if (state.phase !== 'editing' || !state.site) return;
        const reason = disabledTools()[toolKey];
        if (reason) { notify(reason, 'info'); return; }
        const context = siteContext();
        log(`build ${toolKey} on a ${Math.round(draftApi().siteAreaM2(state.site))} m² site (${(context.binding && context.binding.parcels.length) || 0} bound parcels, ${context.binding ? context.binding.source : 'no binding'})`);
        if (STRUCTURES.includes(toolKey)) {
            teardown({ keepSynthetic: false });
            Promise.resolve(win.instantCreateStructureFromSite(toolKey, context))
                .catch(error => console.error('[SiteTool] structure creation failed', error));
            return;
        }
        if (toolKey === 'row' || toolKey === 'parcelBased') { enterPlots(toolKey); return; }
        if (toolKey === 'reparcellization') {
            teardown({ keepSynthetic: false });
            Promise.resolve(win.startSiteSubdivision(context))
                .catch(error => console.error('[SiteTool] subdivision editor failed to open', error));
            return;
        }
        if (toolKey === 'buildings' || toolKey === 'single') {
            const id = `site:${siteKey()}`;
            state.synthetic.clear();
            const polygon = state.site.coordinates.length === 1 ? { type: 'Polygon', coordinates: state.site.coordinates[0] } : state.site;
            state.synthetic.set(id, syntheticFeature(id, polygon, { siteSuperparcel: true }));
            teardown({ keepSynthetic: true });
            Promise.resolve(win.startInstantSiteDesign(toolKey, context, [id]))
                .catch(error => console.error('[SiteTool] design tool failed to open', error));
        }
    }

    function transport(toolKey) {
        // Corridors and stations are drawn by their own tools; they need no site.
        teardown({ keepSynthetic: false });
        win.startParcelTransportTool(toolKey);
    }

    function cutPlots() {
        const api = win.__sitePlots;
        if (!api || !state.site) { state.plots = []; return; }
        const width = state.plotTool === 'row' ? api.ROW_PLOT_WIDTH_M : api.DETACHED_PLOT_WIDTH_M;
        try {
            state.plots = api.cutPlots(state.site, { frontageEdgeIndex: state.frontageIndex, plotWidthM: width, turf: win.turf }) || [];
        } catch (error) {
            console.warn('[SiteTool] plot cutting failed', error);
            state.plots = [];
        }
        log(`cut ${state.plots.length} ${state.plotTool} plot(s) along edge ${state.frontageIndex}`);
    }

    function enterPlots(toolKey) {
        if (!win.__sitePlots) { notify(t('siteTool.errors.plotsUnavailable', 'Plot cutting is not available.'), 'error'); return; }
        state.phase = 'plots';
        state.plotTool = toolKey;
        state.paletteOpen = false;
        state.frontageIndex = win.__sitePlots.defaultFrontageEdge(state.site);
        destroyEditor();
        cutPlots();
        renderLayers();
        renderPanel();
        findStreetFrontage();
    }

    // The longest edge stands in while the streets around the site are looked up; the edge that
    // faces a street then replaces it, unless the user picked an edge meanwhile.
    function findStreetFrontage() {
        if (!win.StreetFrontage) { state.frontageBasis = null; return; }
        const seq = ++state.frontageSeq;
        state.frontageBasis = { basis: 'pending' };
        renderPanel();
        win.StreetFrontage.find(state.site).then(result => {
            if (seq !== state.frontageSeq || state.phase !== 'plots') return;
            state.frontageBasis = result;
            if (result.frontageEdgeIndex !== state.frontageIndex && result.frontageEdgeIndex >= 0) {
                state.frontageIndex = result.frontageEdgeIndex;
                cutPlots();
                renderLayers();
            }
            renderPanel();
        }).catch(error => {
            console.error('[SiteTool] frontage lookup failed', error);
            if (seq !== state.frontageSeq) return;
            state.frontageBasis = { basis: 'longest', reason: 'unavailable' };
            renderPanel();
        });
    }

    function leavePlots() {
        state.phase = 'editing';
        state.plotTool = null;
        state.plots = [];
        state.frontageBasis = null;
        state.frontageSeq += 1;
        beginEditing(state.ring);
    }

    function continueWithPlots() {
        if (!state.plots.length) return;
        if (state.plotTool === 'row' && state.plots.length < 2) {
            notify(t('panel.parcel.build.rowNeedsTwo', 'Row houses need at least two parcels.'), 'info');
            return;
        }
        const key = siteKey();
        state.synthetic.clear();
        const ids = state.plots.map((plot, index) => {
            const id = `site-plot:${key}:${index + 1}`;
            state.synthetic.set(id, syntheticFeature(id, plot.geometry, { plotIndex: index + 1, sitePlot: true }));
            return id;
        });
        const tool = state.plotTool;
        const context = siteContext();
        teardown({ keepSynthetic: true });
        Promise.resolve(win.startInstantSiteDesign(tool, context, ids))
            .catch(error => console.error('[SiteTool] plot design tool failed to open', error));
    }

    // ---- lifecycle ----

    function reset() {
        state.ring = [];
        state.site = null;
        state.siteError = null;
        state.preview = null;
        state.previewParcels = new Map();
        state.openGround = null;
        state.server = null;
        state.serverError = null;
        state.serverPending = false;
        state.serverSeq += 1;
        state.paletteOpen = false;
        state.plotTool = null;
        state.plots = [];
        state.frontageIndex = null;
        state.frontageBasis = null;
        state.frontageSeq += 1;
    }

    function claimMap() {
        const lock = win.__mapEditLock;
        if (lock && !lock.claim(LOCK_OWNER, t('siteTool.title', 'Site'))) {
            notify(t('siteTool.errors.mapBusy', 'Finish the tool that is open first.'), 'info');
            return false;
        }
        return true;
    }

    function prepareMap() {
        win.MapShell?.closeSheets();
        try { win.ParcelMenu && win.ParcelMenu.close(); } catch (_) { }
        try { win.GroundMenu && win.GroundMenu.close(); } catch (_) { }
        try { if (typeof win.hideParcelInfoPanel === 'function') win.hideParcelInfoPanel(); } catch (_) { }
    }

    // Draw a new site. options.ring starts with that outline in edit mode instead.
    function start(options = {}) {
        if (!map() || !win.L || !win.turf || !draftApi() || !bindingApi()) throw new Error('SiteTool: the map or geometry libraries are not loaded');
        if (isActive()) teardown({ keepSynthetic: false });
        if (!claimMap()) return false;
        prepareMap();
        doc.body.classList.add('site-tool-active');
        reset();
        state.synthetic.clear();
        state.ground = options.ground || null;
        state.selectionIds = (options.selectionIds || []).map(String);
        wireMap();
        if (Array.isArray(options.ring) && options.ring.length >= 3) {
            beginEditing(options.ring);
        } else {
            state.phase = 'drawing';
            doc.body.classList.add('site-tool-drawing');
            renderLayers();
            renderPanel();
        }
        log(`started (${state.phase}${state.ground ? `, ground ${state.ground}` : ''})`);
        return true;
    }

    // The union of live parcels as the starting outline of an editable site.
    function startFromParcels(parcelIds) {
        const ids = (parcelIds || []).map(String).filter(Boolean);
        const features = ids.map(id => win.LiveParcelFabric && win.LiveParcelFabric.get(id)).filter(Boolean);
        if (!features.length) {
            notify(t('siteTool.errors.parcelsUnavailable', 'Those parcels are not on the map.'), 'error');
            return false;
        }
        const site = draftApi().siteFromFeatures(features);
        if (!site || site.coordinates.length !== 1) {
            notify(t('proposalDrafts.errors.parcelsNotContiguous', 'The selected parcels must form one connected area.'), 'error');
            return false;
        }
        if (site.coordinates[0].length > 1) log('the selection has holes; the site keeps its outer outline only');
        return start({ ring: site.coordinates[0][0], selectionIds: ids });
    }

    function startFromSelection() {
        const multi = win.multiParcelSelection;
        const ids = multi && multi.selectedParcels ? Array.from(multi.selectedParcels).map(String) : [];
        if (!ids.length) return false;
        try { if (typeof win.cancelMultiParcelSelection === 'function') win.cancelMultiParcelSelection(); } catch (_) { }
        return startFromParcels(ids);
    }

    function redraw() {
        destroyEditor();
        reset();
        state.phase = 'drawing';
        doc.body.classList.add('site-tool-drawing');
        renderLayers();
        renderPanel();
    }

    function teardown(options = {}) {
        destroyEditor();
        unwireMap();
        clearLayers();
        state.phase = 'idle';
        doc.body.classList.remove('site-tool-active');
        doc.body.classList.remove('site-tool-drawing');
        if (state.panel) { state.panel.hidden = true; state.panel.innerHTML = ''; }
        if (win.__mapEditLock) win.__mapEditLock.release(LOCK_OWNER);
        if (!options.keepSynthetic) state.synthetic.clear();
        reset();
    }

    function cancel() {
        log('cancelled');
        teardown({ keepSynthetic: false });
    }

    function current() {
        return {
            phase: state.phase,
            ring: state.ring.slice(),
            site: state.site,
            siteError: state.siteError,
            preview: state.preview,
            server: state.server,
            serverPending: state.serverPending,
            serverError: state.serverError,
            plots: state.plots.slice(),
            frontageIndex: state.frontageIndex,
            frontageBasis: state.frontageBasis,
            synthetic: Array.from(state.synthetic.keys())
        };
    }

    // Re-render labels on a language switch.
    win.addEventListener('i18n:translationsLoaded', () => { if (isActive()) renderPanel(); });

    win.resolveDesignParcelFeature = resolveDesignParcelFeature;
    win.SiteTool = {
        start,
        startFromParcels,
        startFromSelection,
        isActive,
        cancel,
        build,
        transport,
        current,
        finishDrawing
    };
})(window);
