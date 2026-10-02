// Characterize undo wiring in the real structure-geometry editor. The VM invokes its public
// openStructureGeometryEditor entry point and the actual erase/marker handlers; only map,
// Leaflet, DOM, and the history collaborator are small deterministic boundaries.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const editorSource = readFileSync(fileURLToPath(new URL('../../frontend/js/structure-geometry-editor.js', import.meta.url)), 'utf8');

function makeClassList() {
    const classes = new Set();
    return {
        add: value => classes.add(value),
        remove: value => classes.delete(value),
        toggle(value, force) {
            const enabled = force === undefined ? !classes.has(value) : !!force;
            if (enabled) classes.add(value);
            else classes.delete(value);
            return enabled;
        },
        contains: value => classes.has(value)
    };
}

function makeEditorHarness(decorations) {
    const historyInstances = [];
    const mapHandlers = new Map();
    const documentHandlers = new Map();
    const groups = [];
    const panel = {
        classList: makeClassList(),
        listeners: {},
        setAttribute() {},
        addEventListener(type, handler) { this.listeners[type] = handler; },
        removeEventListener() {},
        querySelectorAll(selector) {
            if (selector !== '[data-tool]') return [];
            return [...this.innerHTML.matchAll(/data-tool="([^"]+)"/g)].map((match) => ({
                dataset: { tool: match[1] }, classList: makeClassList(), attributes: {},
                setAttribute(name, value) { this.attributes[name] = value; }
            }));
        },
        querySelector(selector) {
            const element = { hidden: false, disabled: false, textContent: '', setAttribute() {} };
            return /finish-path/.test(selector) ? element : (/data-role/.test(selector) ? element : null);
        },
        fireClick({ tool, action }) {
            const target = {
                closest(selector) {
                    if (tool && selector === '.structure-geometry-tools [data-tool]') return { dataset: { tool } };
                    if (action && selector === '[data-action]') return { dataset: { action } };
                    return null;
                }
            };
            this.listeners.click({ target });
        }
    };

    const document = {
        body: { appendChild() {} },
        createElement() { return panel; },
        addEventListener(type, handler) {
            const handlers = documentHandlers.get(type) || [];
            handlers.push(handler);
            documentHandlers.set(type, handlers);
        },
        removeEventListener(type, handler) {
            documentHandlers.set(type, (documentHandlers.get(type) || []).filter(item => item !== handler));
        },
        fireKey(event) { (documentHandlers.get('keydown') || []).forEach(handler => handler(event)); }
    };

    const map = {
        handlers: mapHandlers,
        getPane() { return null; }, createPane() { return { style: {} }; },
        on(type, handler) {
            const handlers = mapHandlers.get(type) || [];
            handlers.push(handler); mapHandlers.set(type, handlers);
        },
        off(type, handler) { mapHandlers.set(type, (mapHandlers.get(type) || []).filter(item => item !== handler)); },
        dragging: { enable() {}, disable() {} },
        getZoom() { return 18; }, fitBounds() {}, removeLayer() {}
    };
    const groupFactory = () => {
        const group = {
            items: [],
            addTo() { return this; },
            addLayer(layer) { this.items.push(layer); return this; },
            removeLayer(layer) { this.items = this.items.filter(item => item !== layer); return this; },
            clearLayers() { this.items = []; }
        };
        groups.push(group);
        return group;
    };
    const makeLayer = () => ({ addTo(group) { group.addLayer(this); return this; } });
    const markers = [];
    const L = {
        layerGroup: groupFactory,
        geoJSON: () => Object.assign(makeLayer(), { getBounds: () => ({ isValid: () => true }) }),
        divIcon: options => options,
        marker(latlng, options) {
            const marker = Object.assign(makeLayer(), {
                options, latlng, events: {},
                on(type, handler) { this.events[type] = handler; return this; },
                fire(type, event = {}) { this.events[type]?.(event); return this; },
                getLatLng() { return { lat: this.latlng[0], lng: this.latlng[1] }; },
                setLatLng(value) { this.latlng = value; return this; }
            });
            markers.push(marker);
            return marker;
        },
        polygon: () => makeLayer(), polyline: () => makeLayer(),
        DomEvent: { stopPropagation() {}, stop() {} }
    };
    const historyFactory = {
        create(options) {
            const snapshots = [];
            const handler = event => {
                if (!event.ctrlKey && !event.metaKey) return;
                if (String(event.key).toLowerCase() !== 'z') return;
                if (typeof options.enabled === 'function' && !options.enabled()) return;
                event.preventDefault();
                if (!event.shiftKey && snapshots.length) options.restore(snapshots.pop());
            };
            const instance = {
                record() { snapshots.push(JSON.parse(JSON.stringify(options.capture()))); },
                undo() { if (!snapshots.length) return false; options.restore(snapshots.pop()); return true; },
                bindKeyboard(target) { target.addEventListener('keydown', handler, true); },
                destroy() { snapshots.length = 0; }
            };
            historyInstances.push(instance);
            return instance;
        }
    };
    let savedDecorations = null;
    const context = createContext({
        document, map, L, GeometryEditHistory: historyFactory,
        turf: {
            booleanPointInPolygon: () => true,
            point: coordinates => ({ type: 'Point', coordinates }),
            polygon: coordinates => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates } }),
            booleanWithin: () => true,
            booleanEqual: () => false,
            lineString: coordinates => ({ type: 'Feature', geometry: { type: 'LineString', coordinates } })
        },
        proposalDraftStore: { getDraft: () => ({ id: 'draft-1', adapterKey: 'park', editorPayload: { structureProposal: { decorations } } }) },
        syncActiveProposalDraftFromEditor(_section, payload) { savedDecorations = payload.structureProposal.decorations; },
        __mapEditLock: { claim() {}, release() {} },
        ProposalSelection: { getKey: () => null },
        parks: [], squares: [],
        console
    });
    context.window = context;
    runInContext(editorSource, context, { filename: 'frontend/js/structure-geometry-editor.js' });

    return {
        context, panel, groups, markers, historyInstances, document,
        open() {
            return context.openStructureGeometryEditor({
                id: 'draft-1', adapterKey: 'park', editorPayload: {
                    structureProposal: {
                        kind: 'park', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]},
                        decorations: JSON.parse(JSON.stringify(decorations))
                    }
                }
            });
        },
        save() { panel.fireClick({ action: 'save' }); return savedDecorations; },
        undo() { document.fireKey({ key: 'z', ctrlKey: true, preventDefault() {} }); }
    };
}

const currentMarkers = harness => harness.groups.at(-1).items.filter(item => item.events && typeof item.fire === 'function');

describe('structure geometry editor history wiring', () => {
    it('restores an erased tree when the user undoes', () => {
        const harness = makeEditorHarness({ trees: [[0.2, 0.2]], version: 3 });
        expect(harness.open()).toBe(true);
        harness.panel.fireClick({ tool: 'erase' });
        currentMarkers(harness)[0].fire('click', {});
        expect(currentMarkers(harness)).toHaveLength(0);

        harness.undo();
        expect(currentMarkers(harness)).toHaveLength(1);
        expect(harness.save().trees).toEqual([[0.2, 0.2]]);
    });

    it('restores a tree coordinate after a marker drag is undone', () => {
        const harness = makeEditorHarness({ trees: [[0.2, 0.2]], version: 3 });
        expect(harness.open()).toBe(true);
        const marker = currentMarkers(harness)[0];
        marker.fire('dragstart');
        marker.setLatLng([0.35, 0.4]); // Leaflet uses [latitude, longitude].
        marker.fire('dragend');
        expect(marker.getLatLng()).toEqual({ lat: 0.35, lng: 0.4 });

        harness.undo();
        expect(harness.save().trees).toEqual([[0.2, 0.2]]);
    });
});
