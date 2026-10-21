// A fake browser world for frontend/js/road-drawing.js: a Leaflet stand-in (layers, map events, a
// 1 px = 1 m projection), a DOM with the drawing panel's elements, a live parcel fabric, a proposal
// store and a parcel-mutation stub, with the real pure modules (footprint, metric frame, geometry,
// profile, tunnels, stroke reducer, draft store) as the tool's collaborators. Each loadRoadDrawing()
// requires a fresh copy of the tool, so its session state starts clean; dispose() restores globalThis.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const FRONTEND = '../../../frontend/js/';
// ROAD_DRAWING_SOURCE loads another copy of the tool instead (a mutant, for checking that these tests can fail).
const ROAD_DRAWING_PATH = process.env.ROAD_DRAWING_SOURCE || require.resolve(`${FRONTEND}road-drawing.js`);

const turf = require('@turf/turf');
const priceModel = require(`${FRONTEND}financials.js`);
const metricFrame = require(`${FRONTEND}metric-frame.js`);
const corridorFootprint = require(`${FRONTEND}corridor-footprint.js`);
const corridorGeometry = require(`${FRONTEND}corridor-geometry.js`);
const corridorProfile = require(`${FRONTEND}corridor-profile.js`);
const corridorTunnel = require(`${FRONTEND}corridor-tunnel.js`);
const gradeSeparation = require(`${FRONTEND}corridor-grade-separation.js`);
const roadStrokeState = require(`${FRONTEND}road-stroke-state.js`);
const roadFinalizationState = require(`${FRONTEND}road-finalization-state.js`);
const cbFormat = require(`${FRONTEND}format.js`);
const parcelId = require(`${FRONTEND}parcels/parcel-id.js`);
const proposalStatus = require(`${FRONTEND}proposals/status.js`);
const proposalDrafts = require(`${FRONTEND}proposal-drafts.js`);
const corridorDraft = require(`${FRONTEND}corridor-draft.js`);
const formationEdit = require(`${FRONTEND}proposals/formation-edit.js`);

// The drawing area: Zagreb-ish coordinates, so the metric frame is inside its supported domain.
export const LAT0 = 45.813;
export const LNG0 = 15.977;
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG = 111320 * Math.cos(LAT0 * Math.PI / 180);

// A point `east` and `north` metres from the drawing origin.
export function at(east, north) {
    return { lat: LAT0 + north / M_PER_DEG_LAT, lng: LNG0 + east / M_PER_DEG_LNG };
}

// A GeoJSON ring of the axis-aligned box [west, south, east, north] in metres from the origin.
export function boxRing(west, south, east, north) {
    const corners = [at(west, south), at(east, south), at(east, north), at(west, north), at(west, south)];
    return corners.map(point => [point.lng, point.lat]);
}

function spy(impl) {
    const fn = (...args) => { fn.calls.push(args); return impl ? impl(...args) : undefined; };
    fn.calls = [];
    return fn;
}

function makeClassList() {
    const set = new Set();
    return {
        add: (...names) => names.forEach(name => set.add(name)),
        remove: (...names) => names.forEach(name => set.delete(name)),
        contains: name => set.has(name),
        toggle: (name, force) => {
            const on = force === undefined ? !set.has(name) : !!force;
            if (on) set.add(name); else set.delete(name);
            return on;
        },
        values: () => [...set]
    };
}

export function makeElement(id, tagName = 'DIV') {
    const attributes = new Map();
    const style = {};
    Object.defineProperty(style, 'removeProperty', { value: name => { delete style[name]; }, enumerable: false });
    return {
        id, tagName, textContent: '', innerHTML: '', hidden: false, disabled: false, checked: false,
        value: '', dataset: {}, style, classList: makeClassList(), isContentEditable: false,
        setAttribute: (name, value) => attributes.set(name, String(value)),
        getAttribute: name => (attributes.has(name) ? attributes.get(name) : null),
        removeAttribute: name => attributes.delete(name),
        querySelector: () => null,
        querySelectorAll: () => [],
        closest: () => null,
        addEventListener: () => {},
        removeEventListener: () => {},
        blur: spy(),
        focus: spy(),
        getBoundingClientRect: () => ({ width: 0, height: 0 })
    };
}

// The ids road-drawing.js reads and writes: the drawing panel, its metrics, the tool buttons.
const ELEMENT_IDS = [
    'road-info-panel', 'road-drawing-controls', 'road-panel-title', 'road-length-label', 'road-area-label',
    'road-length', 'road-area', 'road-parcels-count', 'road-parcels-area', 'road-open-ground',
    'road-individual-owners', 'road-owned-individuals', 'road-owned-companies', 'road-owned-government',
    'road-owned-institution', 'road-owned-mixed', 'road-ownership-unknown', 'road-market-price', 'road-acquire-difficulty',
    'roadDrawButton', 'trackDrawButton', 'undoRoadButton', 'finishRoadButton', 'editRoadCrossSectionButton',
    'road-panel-minimize', 'status', 'mode-3d-toggle', 'mode-realistic-toggle', 'mode-ai-toggle',
    'showBuildings', 'showBuildingsDgu', 'showBuildingsOsm',
    'proposal-details-panel', 'parcel-info-panel', 'block-info-panel'
];

class FakeLayer {
    constructor(kind, latlngs, options = {}) {
        this.kind = kind;
        this.latlngs = latlngs;
        this.options = { ...options };
        this.styles = [];
        this.tooltip = null;
        this.children = kind === 'group' ? new Set() : null;
    }
    addTo(target) { target.addLayer(this); return this; }
    removeFrom(target) { target.removeLayer(this); return this; }
    setLatLngs(latlngs) { this.latlngs = latlngs; return this; }
    getLatLngs() { return this.latlngs; }
    setLatLng(latlng) { this.latlngs = latlng; return this; }
    setStyle(style) { this.styles.push(style); this.options = { ...this.options, ...style }; return this; }
    setRadius(radius) { this.options.radius = radius; return this; }
    bindTooltip(text) { this.tooltip = text; return this; }
    getTooltip() { return this.tooltip; }
    setTooltipContent(text) { this.tooltip = text; return this; }
    unbindTooltip() { this.tooltip = null; return this; }
    bringToFront() { return this; }
    addLayer(layer) { this.children.add(layer); return this; }
    removeLayer(layer) { this.children.delete(layer); return this; }
    hasLayer(layer) { return this.children.has(layer); }
}

function makeLeaflet() {
    const latLng = (a, b) => (Array.isArray(a) ? { lat: a[0], lng: a[1] } : (typeof a === 'object' ? { lat: a.lat, lng: a.lng } : { lat: a, lng: b }));
    return {
        latLng,
        point: (x, y) => ({ x, y }),
        polyline: (latlngs, options) => new FakeLayer('polyline', latlngs, options),
        polygon: (latlngs, options) => new FakeLayer('polygon', latlngs, options),
        circleMarker: (latlng, options) => new FakeLayer('circleMarker', latLng(latlng), options),
        layerGroup: () => new FakeLayer('group', null),
        DomEvent: { stopPropagation: spy(), stop: spy(), preventDefault: spy() }
    };
}

function makeMap() {
    const layers = new Set();
    const handlers = new Map();
    const panes = new Map();
    const container = makeElement('map');
    let doubleClickZoom = true;
    return {
        layers,
        handlers,
        addLayer(layer) { layers.add(layer); return this; },
        removeLayer(layer) { layers.delete(layer); return this; },
        hasLayer(layer) { return layers.has(layer); },
        on(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); return this; },
        off(type, fn) { handlers.get(type)?.delete(fn); return this; },
        listens(type) { return (handlers.get(type)?.size || 0) > 0; },
        // Calls every handler for `type` and resolves when the async ones have settled.
        fire(type, event) { return Promise.all([...(handlers.get(type) || [])].map(fn => fn(event))); },
        latLngToLayerPoint(latlng) { return { x: (latlng.lng - LNG0) * M_PER_DEG_LNG, y: (LAT0 - latlng.lat) * M_PER_DEG_LAT }; },
        layerPointToLatLng(point) { return { lat: LAT0 - point.y / M_PER_DEG_LAT, lng: LNG0 + point.x / M_PER_DEG_LNG }; },
        getContainer: () => container,
        getPane: name => panes.get(name) || null,
        createPane: name => { const pane = { style: {} }; panes.set(name, pane); return pane; },
        getBounds: () => ({ west: LNG0 - 0.01, east: LNG0 + 0.01, south: LAT0 - 0.01, north: LAT0 + 0.01 }),
        getZoom: () => 17,
        doubleClickZoom: {
            enabled: () => doubleClickZoom,
            disable: () => { doubleClickZoom = false; },
            enable: () => { doubleClickZoom = true; }
        }
    };
}

function makeDocument() {
    const elements = new Map(ELEMENT_IDS.map(id => [id, makeElement(id, /^show/.test(id) ? 'INPUT' : 'DIV')]));
    const listeners = new Map();
    const body = makeElement('body', 'BODY');
    const events = [];
    return {
        elements,
        events,
        body,
        readyState: 'complete',
        getElementById: id => elements.get(id) || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: tag => makeElement(null, String(tag).toUpperCase()),
        addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
        removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
        listeners: type => [...(listeners.get(type) || [])],
        dispatchEvent(event) {
            events.push(event);
            (listeners.get(event.type) || []).forEach(fn => fn(event));
            return true;
        }
    };
}

// A live parcel fabric over `parcels` = [{ id, ring, properties }]: the bounds query, the lookup,
// and base-id provenance (every parcel here is its own cadastral base).
function makeFabric(parcels) {
    const features = new Map();
    const setParcels = list => {
        features.clear();
        (list || []).forEach(parcel => {
            features.set(String(parcel.id), {
                type: 'Feature',
                properties: { parcelId: String(parcel.id), calculatedArea: 100, ...(parcel.properties || {}) },
                geometry: { type: 'Polygon', coordinates: [parcel.ring] }
            });
        });
    };
    setParcels(parcels);
    return {
        setParcels,
        get: id => features.get(String(id)) || null,
        queryBounds: bbox => [...features.values()].filter(feature => {
            const [w, s, e, n] = turf.bbox(feature);
            return w <= bbox[2] && e >= bbox[0] && s <= bbox[3] && n >= bbox[1];
        }),
        cadastreIdsForParcelIds: ids => [...new Set((ids || []).map(String))]
    };
}

function makeProposalStore(initial = []) {
    const proposals = new Map();
    let nextId = 1;
    const add = proposal => {
        const id = String(proposal.proposalId || `p-${nextId++}`);
        proposal.proposalId = id;
        proposals.set(id, proposal);
        return id;
    };
    initial.forEach(add);
    return {
        proposals,
        getAllProposals: () => [...proposals.values()],
        getProposal: id => proposals.get(String(id)) || null,
        findProposalByIdOrHash: id => proposals.get(String(id)) || null,
        addProposal: spy(add),
        _indexProposal: spy(),
        save: spy()
    };
}

function memoryStorage() {
    const map = new Map();
    return {
        getItem: key => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => { map.set(key, String(value)); },
        removeItem: key => { map.delete(key); },
        map
    };
}

// A stand-in for corridor-render.js (the Leaflet canvas renderer the drawing's cross-section is
// drawn with): its panes and three render calls, each recording what it was handed in `rendered`.
function makeCorridorRenderer(rendered) {
    return {
        CORRIDOR_STRIPS_PANE: 'corridorStripsPane',
        CORRIDOR_JUNCTIONS_PANE: 'corridorJunctionsPane',
        CORRIDOR_MARKINGS_PANE: 'corridorMarkingsPane',
        ensureCorridorStripsPane: () => {},
        ensureCorridorJunctionsPane: () => {},
        ensureCorridorMarkingsPane: () => {},
        renderCorridorStrips: (strips, renderOptions = {}) => {
            rendered.strips.push({ strips, options: renderOptions });
            return new FakeLayer('strips', null, { pane: renderOptions.pane });
        },
        renderCorridorJunctions: (junctions, group, pane) => {
            rendered.junctions.push({ junctions, pane });
            new FakeLayer('junctions', null, { pane }).addTo(group);
        },
        renderCorridorLaneMarkings: (markings, group, pane) => {
            rendered.markings.push({ markings, pane });
        },
        // corridor-profile.js puts buildCorridorStrips on window only, not on module.exports. The
        // drawing calls it one segment at a time, which buildCorridorPieceStrips reaches exactly
        // for an untapered piece.
        buildCorridorStrips: (segments, profile, frame) => {
            if (!Array.isArray(segments) || segments.length !== 1) throw new Error('buildCorridorStrips stand-in: one segment at a time');
            return corridorProfile.buildCorridorPieceStrips({ points: segments[0], profile, taper: null }, frame);
        }
    };
}

// Installs the world on globalThis (window === globalThis, as in a browser) and loads a fresh copy
// of road-drawing.js. `options.parcels` seeds the fabric, `options.proposals` the proposal store;
// `options.renderer` installs the corridor-render.js stand-in, whose calls land in `env.rendered`.
export function loadRoadDrawing(options = {}) {
    const before = new Map(Object.getOwnPropertyNames(globalThis)
        .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const g = globalThis;
    const statuses = [];
    const document = makeDocument();
    const map = makeMap();
    const fabric = makeFabric(options.parcels || []);
    const presenterLayers = new Map();
    const store = makeProposalStore(options.proposals || []);
    const afterCommits = [];
    const draftStore = proposalDrafts.createProposalDraftStore({ storage: memoryStorage() });
    const rendered = { strips: [], junctions: [], markings: [] };

    const installs = {
        window: g,
        ParcelPriceModel: { buildEstimate: priceModel.buildParcelPriceEstimate, aggregate: priceModel.aggregateParcelPriceEstimates },
        document,
        map,
        L: makeLeaflet(),
        turf,
        __metricFrame: metricFrame,
        __corridorFootprint: corridorFootprint,
        CorridorGeometry: corridorGeometry,
        RoadStrokeState: roadStrokeState,
        RoadFinalizationState: roadFinalizationState,
        CbFormat: cbFormat,
        RoadOwnershipModel: require(`${FRONTEND}road-ownership-model.js`),
        ProposalOrigin: require(`${FRONTEND}proposals/origin.js`),
        Cid: require(`${FRONTEND}cid.js`),
        getBackendBase: () => 'https://api.example.test',
        PersistentStorage: memoryStorage(),
        __formationEdit: formationEdit,
        ...corridorGeometry,
        ...corridorProfile,
        ...corridorTunnel,
        ...gradeSeparation,
        ...parcelId,
        isApplied: proposalStatus.isApplied,
        setProposalApplied: proposalStatus.setProposalApplied,
        saveActiveCorridorDraft: corridorDraft.saveActiveCorridorDraft,
        roadStyle: { kind: 'road-style' },
        normalStyle: { kind: 'normal-style' },
        getProposalKey: proposal => proposal?.proposalId || null,
        updateStatus: spy(message => statuses.push(message)),
        LiveParcelFabric: fabric,
        ParcelPresenter: {
            getLayer: id => {
                const key = String(id);
                if (!fabric.get(key)) return null;
                if (!presenterLayers.has(key)) presenterLayers.set(key, new FakeLayer('parcel', null));
                return presenterLayers.get(key);
            }
        },
        proposalStorage: store,
        ProposalManager: {
            runParcelMutation: spy(async (kind, id, run) => {
                const mutation = { proposals: store, afterCommit: callback => afterCommits.push(callback) };
                const result = await run({ _parcelMutation: mutation });
                afterCommits.splice(0).forEach(callback => callback());
                return result;
            }),
            rematerializeCorridorScope: spy(async () => ({ ok: true })),
            createCorridorProposalAtomically: spy(async () => ({ ok: true, proposalId: 'fork-1' })),
            _refreshUIAfterProposalChange: spy()
        },
        // Published = a design CID mark, as proposals/lineage.js reads it (`published.cid`).
        ProposalLineage: { isPublished: proposal => !!(proposal?.published && require(`${FRONTEND}cid.js`).isCid(proposal.published.cid)) },
        ProposalAuthoredRecord: { restrictLandClaimsToAnchors: spy() },
        ProposalSelection: { is: () => false, has: () => false, clear: spy() },
        selectAndHighlightProposal: spy(),
        BusyControl: { track: (_element, run) => run() },
        proposalDraftStore: draftStore,
        activeProposalDesignDraftId: null,
        beginProposalDraftDesignSession: spy(id => { g.activeProposalDesignDraftId = id; }),
        finishProposalDraftDesignSession: spy(() => { g.activeProposalDesignDraftId = null; }),
        syncActiveProposalDraftFromEditor: spy(),
        instantCreateProposalFromDraft: spy(async () => 'p-built'),
        showStyledChoice: spy(async () => 'keep'),
        showStyledAlert: spy(),
        ...(options.renderer ? makeCorridorRenderer(rendered) : {}),
        ...(options.globals || {})
    };
    Object.entries(installs).forEach(([name, value]) => { g[name] = value; });

    delete require.cache[ROAD_DRAWING_PATH];
    const api = require(ROAD_DRAWING_PATH);

    const env = {
        api,
        session: api.session,
        map,
        document,
        fabric,
        store,
        draftStore,
        presenterLayers,
        rendered,
        statuses,
        lastStatus: () => statuses[statuses.length - 1],
        element: id => document.getElementById(id),
        // A map click at `point`; `extra.altKey` suppresses snapping, `extra.detail` 2 is a dblclick's second tap.
        click(point, extra = {}) {
            return map.fire('click', {
                latlng: { lat: point.lat, lng: point.lng },
                originalEvent: { detail: extra.detail ?? 1, pointerType: 'mouse', altKey: !!extra.altKey }
            });
        },
        move(point, extra = {}) {
            return map.fire('mousemove', { latlng: { lat: point.lat, lng: point.lng }, originalEvent: { altKey: !!extra.altKey } });
        },
        // A keydown on the document; returns the event so its preventDefault can be checked.
        key(key, extra = {}) {
            const event = {
                type: 'keydown', key, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
                target: makeElement(null, extra.tagName || 'DIV'), defaultPrevented: false,
                ...extra,
                preventDefault() { this.defaultPrevented = true; }
            };
            document.listeners('keydown').forEach(fn => fn(event));
            return event;
        },
        // Waits until no click is being placed and no finish is running (bounded; throws if it never settles).
        async idle() {
            for (let i = 0; i < 200; i += 1) {
                await new Promise(resolve => setTimeout(resolve, 0));
                if (!api.session.roadSegmentPlacement && !api.session.roadFinalizationGate.isRunning()) return;
            }
            throw new Error('road drawing never settled');
        },
        layersOfKind: kind => [...map.layers].filter(layer => layer.kind === kind),
        dispose() {
            Object.getOwnPropertyNames(g).forEach(name => {
                if (!before.has(name)) delete g[name];
            });
            before.forEach((descriptor, name) => {
                const current = Object.getOwnPropertyDescriptor(g, name);
                if (current && current.value === descriptor.value && current.get === descriptor.get) return;
                try { Object.defineProperty(g, name, descriptor); } catch (_) { }
            });
            delete require.cache[ROAD_DRAWING_PATH];
        }
    };
    return env;
}
