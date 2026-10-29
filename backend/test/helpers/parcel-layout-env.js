// A fake browser world for frontend/js/parcel-layout.js (the parcel-layout editor): a DOM
// (fake-dom.js), a Leaflet stand-in whose GeoJSON layers carry their plots' handlers, an OnMapEditor
// that mounts the editor's panels into the document, a live parcel fabric, and the real pure modules
// (layouts, validation, plan utils, topology, cut, edit check, slicing, Schelling grid, history). The
// shared node-handle layer is recorded instead of drawn, so a test can drive a node move through the
// options the editor gave it. Each makeEditor() is a fresh editor with fresh state.
import { createRequire } from 'node:module';
import { makeDocument, makeEvent } from './fake-dom.js';

const require = createRequire(import.meta.url);
const FRONTEND = '../../../frontend/js/';
// PARCEL_LAYOUT_SOURCE loads another copy of the editor (a mutant, for checking that these tests can fail).
const EDITOR_PATH = process.env.PARCEL_LAYOUT_SOURCE || require.resolve(`${FRONTEND}parcel-layout.js`);

const turf = require('@turf/turf');
const MODULES = {
    __reparcellizationUiState: 'reparcellization-ui-state.js',
    ReparcellizationPlanUtils: 'reparcellization-plan-utils.js',
    ReparcellizationSlice: 'reparcellization-slice.js',
    ParcelLayoutValidation: 'parcel-layout-validation.js',
    ParcelLayoutLayouts: 'parcel-layout-layouts.js',
    SchellingGrid: 'parcels/schelling-grid.js',
    SchellingSettings: 'schelling/schelling-settings.js',
    LocalFrame: 'local-frame.js',
    ReparcelLabelPoint: 'reparcel-label-point.js',
    __plotTopology: 'proposals/plot-topology.js',
    __plotCut: 'proposals/plot-cut.js',
    __plotEdit: 'proposals/plot-edit.js',
    __subdivision: 'proposals/subdivision.js',
    __planOrder: 'proposals/plan-order.js',
    GeometryTolerances: 'geometry-tolerances.js',
    GeometryEditHistory: 'geometry-edit/history.js',
    CbFormat: 'format.js'
};

// The pool: metres from an origin at 45.81 N, so turf areas are real square metres.
export const LAT0 = 45.81;
export const LNG0 = 15.97;
const M_PER_DEG_LAT = 111132;
const M_PER_DEG_LNG = 111320 * Math.cos(LAT0 * Math.PI / 180);

export function lngLat(east, north) {
    return [LNG0 + east / M_PER_DEG_LNG, LAT0 + north / M_PER_DEG_LAT];
}

// A GeoJSON Polygon of the axis-aligned box [west, south, east, north] in metres.
export function box(west, south, east, north) {
    return { type: 'Polygon', coordinates: [[lngLat(west, south), lngLat(east, south), lngLat(east, north), lngLat(west, north), lngLat(west, south)]] };
}

function spy(impl) {
    const fn = (...args) => { fn.calls.push(args); return impl ? impl(...args) : undefined; };
    fn.calls = [];
    return fn;
}

// Leaflet stand-ins. Layers know their map/group, fire their own events, and GeoJSON layers build
// one sublayer per feature through the caller's style/onEachFeature, as Leaflet does.
class FakeEvented {
    constructor() { this.handlers = new Map(); }
    on(type, fn) { String(type).split(/\s+/).forEach(t => { if (!this.handlers.has(t)) this.handlers.set(t, []); this.handlers.get(t).push(fn); }); return this; }
    once(type, fn) { const wrapped = event => { this.off(type, wrapped); fn(event); }; return this.on(type, wrapped); }
    off(type, fn) { const list = this.handlers.get(type); if (list) this.handlers.set(type, fn ? list.filter(f => f !== fn) : []); return this; }
    fire(type, event = {}) { (this.handlers.get(type) || []).slice().forEach(fn => fn({ type, target: this, ...event })); return this; }
    listens(type) { return (this.handlers.get(type) || []).length > 0; }
}

class FakeLayer extends FakeEvented {
    constructor(kind, latlngs, options = {}) {
        super();
        this.kind = kind;
        this.latlngs = latlngs;
        this.options = { ...options };
        this.container = null;
        this.tooltip = null;
        this.children = [];
    }
    addTo(target) { target.addLayer(this); return this; }
    remove() { if (this.container) this.container.removeLayer(this); return this; }
    removeFrom(target) { target.removeLayer(this); return this; }
    setStyle(style) { this.options = { ...this.options, ...style }; return this; }
    setLatLngs(latlngs) { this.latlngs = latlngs; return this; }
    getLatLngs() { return this.latlngs; }
    getLatLng() { return this.latlngs; }
    setLatLng(latlng) { this.latlngs = toLatLng(latlng); return this; }
    bindTooltip(text) { this.tooltip = text; return this; }
    unbindTooltip() { this.tooltip = null; return this; }
    closeTooltip() { return this; }
    bringToFront() { return this; }
    setIcon(icon) { this.options.icon = icon; return this; }
    // Group behaviour (layerGroup, geoJSON).
    addLayer(layer) { if (layer.container && layer.container !== this) layer.container.removeLayer(layer); layer.container = this; if (!this.children.includes(layer)) this.children.push(layer); return this; }
    removeLayer(layer) { this.children = this.children.filter(child => child !== layer); if (layer.container === this) layer.container = null; return this; }
    hasLayer(layer) { return this.children.includes(layer); }
    clearLayers() { [...this.children].forEach(child => this.removeLayer(child)); return this; }
    eachLayer(fn) { this.children.slice().forEach(fn); return this; }
    getLayers() { return this.children.slice(); }
    getBounds() { return boundsOf(this.feature || { type: 'FeatureCollection', features: this.children.map(child => child.feature).filter(Boolean) }); }
}

function toLatLng(a, b) {
    if (Array.isArray(a)) return { lat: a[0], lng: a[1] };
    if (a && typeof a === 'object') return { lat: a.lat, lng: a.lng };
    return { lat: a, lng: b };
}

function boundsOf(geojson) {
    const [w, s, e, n] = turf.bbox(geojson);
    return {
        isValid: () => [w, s, e, n].every(Number.isFinite),
        getCenter: () => ({ lat: (s + n) / 2, lng: (w + e) / 2 }),
        getSouthWest: () => ({ lat: s, lng: w }),
        getNorthEast: () => ({ lat: n, lng: e }),
        bbox: [w, s, e, n]
    };
}

function featuresOf(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data.flatMap(featuresOf);
    if (data.type === 'FeatureCollection') return data.features || [];
    if (data.type === 'Feature') return [data];
    return [{ type: 'Feature', properties: {}, geometry: data }];
}

function makeLeaflet() {
    const latLng = toLatLng;
    return {
        latLng,
        point: (x, y) => ({ x, y }),
        geoJSON(data, options = {}) {
            const group = new FakeLayer('geojson', null, options);
            featuresOf(data).forEach(feature => {
                const style = typeof options.style === 'function' ? options.style(feature) : options.style;
                const layer = new FakeLayer('path', null, { ...(style || {}), pane: options.pane, interactive: options.interactive });
                layer.feature = feature;
                if (typeof options.onEachFeature === 'function') options.onEachFeature(feature, layer);
                group.addLayer(layer);
            });
            return group;
        },
        GeoJSON: {
            coordsToLatLngs: (coords, levels = 0) => (levels
                ? coords.map(c => L().GeoJSON.coordsToLatLngs(c, levels - 1))
                : coords.map(([lng, lat]) => ({ lat, lng })))
        },
        polyline: (latlngs, options) => new FakeLayer('polyline', latlngs, options),
        polygon: (latlngs, options) => new FakeLayer('polygon', latlngs, options),
        circleMarker: (latlng, options) => new FakeLayer('circleMarker', latLng(latlng), options),
        marker: (latlng, options) => new FakeLayer('marker', latLng(latlng), options),
        divIcon: options => ({ ...options }),
        layerGroup: (layers = []) => { const group = new FakeLayer('group', null); layers.forEach(layer => group.addLayer(layer)); return group; },
        popup(options = {}) {
            const popup = new FakeLayer('popup', null, options);
            popup.setLatLng = latlng => { popup.latlngs = latlng ? latLng(latlng) : null; return popup; };
            popup.setContent = content => { popup.content = content; return popup; };
            popup.getContent = () => popup.content;
            popup.openOn = map => { map.openPopup(popup); return popup; };
            return popup;
        },
        DomEvent: { stop: spy(), stopPropagation: spy(), preventDefault: spy() }
    };
}
let leafletRef = null;
const L = () => leafletRef;

function makeMap() {
    const map = new FakeLayer('map', null);
    const panes = new Map();
    const container = { style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, scrollIntoView() {} };
    let center = { lat: LAT0, lng: LNG0 };
    let zoom = 19;
    let dblZoom = true;
    Object.assign(map, {
        _popup: null,
        getPane: name => panes.get(name) || null,
        createPane: name => { const pane = { style: {} }; panes.set(name, pane); return pane; },
        whenReady: callback => { callback(); return map; },
        getContainer: () => container,
        getCenter: () => ({ ...center }),
        getZoom: () => zoom,
        getSize: () => ({ x: 800, y: 600 }),
        setView: (latlng, z) => { center = toLatLng(latlng); if (Number.isFinite(z)) zoom = z; return map; },
        fitBounds: spy(),
        // 1 px = 0.2 m around the centre: enough for the pixel-scaled snap radii.
        latLngToContainerPoint: latlng => ({ x: (latlng.lng - center.lng) * M_PER_DEG_LNG * 5 + 400, y: (center.lat - latlng.lat) * M_PER_DEG_LAT * 5 + 300 }),
        containerPointToLatLng: point => ({ lat: center.lat - (point.y - 300) / 5 / M_PER_DEG_LAT, lng: center.lng + (point.x - 400) / 5 / M_PER_DEG_LNG }),
        project: latlng => ({ x: latlng.lng * M_PER_DEG_LNG * 5, y: -latlng.lat * M_PER_DEG_LAT * 5 }),
        unproject: point => ({ lat: -point.y / 5 / M_PER_DEG_LAT, lng: point.x / 5 / M_PER_DEG_LNG }),
        openPopup(popup) { if (map._popup && map._popup !== popup) map.closePopup(map._popup); map._popup = popup; map.addLayer(popup); return map; },
        closePopup(popup) {
            const target = popup || map._popup;
            if (!target) return map;
            if (map._popup === target) map._popup = null;
            if (map.hasLayer(target)) { map.removeLayer(target); target.fire('remove'); }
            return map;
        },
        doubleClickZoom: { enabled: () => dblZoom, enable: () => { dblZoom = true; }, disable: () => { dblZoom = false; } }
    });
    return map;
}

function memoryStorage() {
    const map = new Map();
    return { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
}

// Installs the world and returns { editor, ... }. `options.parcels` = [{ id, geometry, properties }]
// seeds the live fabric (and the cadastre repository); `options.selection` is the map selection the
// editor opens on; `options.pendingLayout` the opener's seed (window.pendingParcelLayout);
// `options.draft` the active design draft; `options.schelling` the Schelling plan layer's current
// settings (no layer when absent); `options.globals` overrides anything installed.
export function makeEditor(options = {}) {
    const g = globalThis;
    const before = new Map(Object.getOwnPropertyNames(g).map(name => [name, Object.getOwnPropertyDescriptor(g, name)]));
    const document = makeDocument();
    const map = makeMap();
    leafletRef = makeLeaflet();
    const statuses = [];
    const windowListeners = new Map();
    const features = new Map((options.parcels || []).map(parcel => [String(parcel.id), {
        type: 'Feature',
        properties: { parcelId: String(parcel.id), BROJ_CESTICE: String(parcel.id), ...(parcel.properties || {}) },
        geometry: parcel.geometry
    }]));
    const handleLayers = [];
    const sessions = [];
    const draft = options.draft === undefined ? { id: 'draft-1', goal: 'parcel-layout', fields: {} } : options.draft;

    const installs = {
        window: g,
        document,
        map,
        L: leafletRef,
        turf,
        escapeHtml: require(`${FRONTEND}shared-utils.js`).escapeHtml,
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        addEventListener: (type, fn) => { if (!windowListeners.has(type)) windowListeners.set(type, new Set()); windowListeners.get(type).add(fn); },
        removeEventListener: (type, fn) => { windowListeners.get(type)?.delete(fn); },
        CityMoney: require(`${FRONTEND}city-money.js`),
        ParcelPriceModel: (() => {
            const model = require(`${FRONTEND}financials.js`);
            return { buildEstimate: model.buildParcelPriceEstimate, aggregate: model.aggregateParcelPriceEstimates };
        })(),
        LiveParcelFabric: {
            get: id => features.get(String(id)) || null,
            cadastreIdsForParcelIds: ids => ids.map(String),
            queryBounds: () => []
        },
        CadastralParcelRepository: {
            get: id => features.get(String(id)) || null,
            ensureIds: spy(async () => {})
        },
        getCurrentParcelSelectionContext: () => options.selection || null,
        buildGeometryFromParcels: ids => {
            const list = ids.map(id => features.get(String(id))).filter(Boolean);
            if (!list.length) return null;
            return list.slice(1).reduce((merged, feature) => turf.union(merged, feature) || merged, list[0]).geometry;
        },
        getActiveProposalDesignDraft: () => draft,
        syncActiveProposalDraftFromEditor: spy(),
        finishProposalDraftDesignSession: spy(),
        discardProposalDraftDesignSession: spy(),
        CbDialog: { confirm: spy(async () => true) },
        showEphemeralMessage: spy(),
        updateStatus: spy(message => statuses.push(message)),
        proposalStorage: { getAllProposals: () => options.proposals || [], getProposal: () => null },
        GeometryEditHandles: {
            create: spy(handleOptions => {
                const layer = {
                    options: handleOptions,
                    destroyed: false,
                    render: () => handleOptions.topologyOf(handleOptions.getShapes()),
                    destroy: () => { layer.destroyed = true; }
                };
                handleLayers.push(layer);
                return layer;
            })
        },
        OnMapEditor: {
            open: spy(openOptions => {
                const root = document.createElement('div');
                root.className = 'on-map-editor';
                [openOptions.tools, openOptions.content, openOptions.footer].filter(Boolean).forEach(part => root.appendChild(part));
                document.body.appendChild(root);
                const session = {
                    options: openOptions, root, map, tools: openOptions.tools,
                    close: spy(() => root.remove()), setHint: spy(), fitFeature: spy()
                };
                sessions.push(session);
                return session;
            })
        },
        ...(options.schelling ? { SchellingLayer: { settings: () => ({ ...options.schelling }) } } : {}),
        ...Object.fromEntries(Object.entries(MODULES).map(([name, file]) => [name, require(`${FRONTEND}${file}`)])),
        ...(options.globals || {})
    };
    Object.entries(installs).forEach(([name, value]) => { g[name] = value; });
    g.localStorage = memoryStorage();
    g.pendingParcelLayout = options.pendingLayout === undefined ? null : options.pendingLayout;

    delete require.cache[EDITOR_PATH];
    const { createParcelLayoutEditor } = require(EDITOR_PATH);
    const editor = createParcelLayoutEditor();

    const env = {
        editor,
        state: editor.state,
        document,
        map,
        statuses,
        handleLayers,
        sessions,
        draft,
        session: () => sessions[sessions.length - 1] || null,
        // The editor's own panel element for a selector (throws when it is not there).
        $(selector) {
            const root = editor.state.modal;
            const element = root && root.querySelector(selector);
            if (!element) throw new Error(`no ${selector} in the editor`);
            return element;
        },
        statusText: () => editor.state.statusEl?.textContent || '',
        // A key on the window (where the editor and the shared history listen).
        key(key, extra = {}) {
            const event = makeEvent('keydown', { key, target: document.body, ...extra });
            (windowListeners.get('keydown') || []).forEach(fn => fn(event));
            return event;
        },
        // The plot layers on the map, in plot order.
        plotLayers: () => (editor.state.previewLayer ? editor.state.previewLayer.getLayers() : []),
        // Click plot `index` on the map, at its centre.
        clickPlot(index) {
            const layer = env.plotLayers()[index];
            if (!layer) throw new Error(`no plot ${index} on the map`);
            const [lng, lat] = turf.centroid(layer.feature).geometry.coordinates;
            layer.fire('click', { latlng: { lat, lng }, originalEvent: {} });
        },
        popup: () => map._popup,
        // A map click at [east, north] metres (for the drawing tools).
        clickAt(east, north, extra = {}) {
            const [lng, lat] = lngLat(east, north);
            map.fire('click', { latlng: { lat, lng }, originalEvent: { ...extra } });
        },
        handles: () => handleLayers.filter(layer => !layer.destroyed).at(-1) || null,
        windowListeners: type => [...(windowListeners.get(type) || [])],
        dispose() {
            Object.getOwnPropertyNames(g).forEach(name => { if (!before.has(name)) delete g[name]; });
            before.forEach((descriptor, name) => {
                const current = Object.getOwnPropertyDescriptor(g, name);
                if (current && current.value === descriptor.value && current.get === descriptor.get) return;
                try { Object.defineProperty(g, name, descriptor); } catch (_) { }
            });
            delete require.cache[EDITOR_PATH];
        }
    };
    return env;
}
