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

function makeEditorHarness(decorations, options = {}) {
    const kind = options.kind || 'park';
    const geometry = options.geometry || { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
    const draft = {
        id: 'draft-1', adapterKey: kind, goal: kind, sourceProposalId: 'proposal-1',
        sourceSnapshot: { proposalId: 'proposal-1' },
        editorPayload: { structureProposal: { kind, geometry, decorations, lakeGraphics: options.lakeGraphics || null } }
    };
    const historyInstances = [];
    const mapHandlers = new Map();
    const documentHandlers = new Map();
    const groundRecords = [];
    const lakeError = { hidden: true, textContent: '' };
    const lakeSave = { disabled: false };
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
            if (selector === '[data-role="lake-error"]') return lakeError;
            if (selector === '[data-action="save"]') return lakeSave;
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
    let savedPayload = null;
    let polygonEditorOptions = null;
    let polygonEditorDestroyed = false;
    const finishedDrafts = [];
    const mapEditorSessions = [];
    const mapEditorOptions = [];
    const fitFeatures = [];
    let lockAllowed = options.lockAllowed !== false;
    const editLock = {
        claim() { return lockAllowed; },
        release() {}
    };
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
        proposalDraftStore: { getDraft: () => draft },
        proposalEditorAdapterRegistry: {
            get(key) {
                if (key !== 'lake' || options.adapterAvailable === false) return null;
                return {
                    serializeProposal(candidate) {
                        const serialized = JSON.parse(JSON.stringify(candidate));
                        const structureProposal = serialized.editorPayload.structureProposal;
                        serialized.structureProposal = structureProposal;
                        serialized.geometry = JSON.parse(JSON.stringify(serialized.editorPayload.geometry));
                        return serialized;
                    }
                };
            }
        },
        ProposalManager: options.managerAvailable === false ? null : {
            getProposalGroundFailure(record) {
                groundRecords.push(record);
                return options.groundFailure?.(record) || null;
            }
        },
        syncActiveProposalDraftFromEditor(_section, payload) {
            savedPayload = payload;
            savedDecorations = payload.structureProposal.decorations;
        },
        finishProposalDraftDesignSession(id) { finishedDrafts.push(id); },
        updateStatus(message) { context.lastStatus = message; },
        buildLakeGraphicsFromGeometry(value) { return { geometry: value, shore: { type: 'Polygon', coordinates: [] }, water: { type: 'Polygon', coordinates: [] }, version: 'fresh' }; },
        PolygonGeometryEditor: {
            create(value) {
                polygonEditorOptions = value;
                return { destroy() { polygonEditorDestroyed = true; } };
            }
        },
        __mapEditLock: editLock,
        OnMapEditor: {
            open(value) {
                mapEditorOptions.push(value);
                if (!editLock.claim(value.owner, value.title)) return null;
                panel.innerHTML = `<header><h2>${value.title}</h2></header>${value.content}${value.footer}`;
                const session = {
                    root: panel, pane: 'onMapEditorPane', handlePane: 'onMapEditorHandles',
                    fitFeature(feature) { fitFeatures.push(feature); },
                    close() { panel.classList.remove('is-open'); }
                };
                mapEditorSessions.push(session);
                return session;
            }
        },
        ProposalSelection: { getKey: () => null },
        parks: [], squares: [],
        console
    });
    context.window = context;
    runInContext(editorSource, context, { filename: 'frontend/js/structure-geometry-editor.js' });

    return {
        context, panel, groups, markers, historyInstances, document,
        draft,
        groundRecords,
        lakeError,
        lakeSave,
        get polygonEditorOptions() { return polygonEditorOptions; },
        get polygonEditorDestroyed() { return polygonEditorDestroyed; },
        get finishedDrafts() { return finishedDrafts; },
        get savedPayload() { return savedPayload; },
        mapEditorOptions, mapEditorSessions, fitFeatures,
        open() {
            return context.openStructureGeometryEditor({
                ...draft,
                editorPayload: { structureProposal: JSON.parse(JSON.stringify(draft.editorPayload.structureProposal)) }
            });
        },
        save() {
            panel.fireClick({ action: 'save' });
            return savedPayload?.structureProposal?.kind === 'lake'
                ? savedPayload
                : (savedPayload?.structureProposal?.decorations || savedDecorations);
        },
        cancel() { panel.fireClick({ action: 'cancel' }); },
        undo() { document.fireKey({ key: 'z', ctrlKey: true, preventDefault() {} }); }
    };
}

const currentMarkers = harness => harness.groups.at(-1).items.filter(item => item.events && typeof item.fire === 'function');

describe('structure geometry editor history wiring', () => {
    it('blocks a lake edit outside its authored ground, keeps the edit open, then allows a valid save', () => {
        const originalRing = [[0, 0], [1, 0], [1, 1], [0, 1]];
        const geometry = { type: 'Polygon', coordinates: [[...originalRing, originalRing[0]]] };
        const outsideRing = [[0, 0], [1.25, 0], [1, 1], [0, 1]];
        const harness = makeEditorHarness(null, {
            kind: 'lake', geometry,
            groundFailure(record) {
                return record.geometry.coordinates[0][1][0] > 1
                    ? { code: 'proposal-footprint-outside-cadastre', message: 'Outside the selected parcels.' }
                    : null;
            }
        });

        expect(harness.open()).toBe(true);
        expect(harness.polygonEditorOptions.onCommit({ ring: outsideRing, reason: 'move' })).toBe(true);
        expect(harness.groundRecords.at(-1).geometry.coordinates[0][1]).toEqual([1.25, 0]);
        expect(harness.draft.editorPayload.structureProposal.geometry).toEqual(geometry);
        expect(harness.lakeError).toMatchObject({ hidden: false, textContent: 'Outside the selected parcels.' });
        expect(harness.lakeSave.disabled).toBe(true);

        harness.save();
        expect(harness.context.isStructureGeometryEditorActive()).toBe(true);
        expect(harness.savedPayload).toBeNull();

        expect(harness.polygonEditorOptions.onCommit({ ring: originalRing, reason: 'undo' })).toBe(true);
        expect(harness.lakeError.hidden).toBe(true);
        expect(harness.lakeError.textContent).toBe('');
        expect(harness.lakeSave.disabled).toBe(false);
        const saved = harness.save().structureProposal;
        expect(saved.geometry.coordinates[0]).toEqual([...originalRing, originalRing[0]]);
        expect(saved.lakeGraphics.version).toBe('fresh');
        expect(harness.context.isStructureGeometryEditorActive()).toBe(false);
    });

    it('keeps lake save disabled when the ground guard or serializer is unavailable', () => {
        const geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
        const noManager = makeEditorHarness(null, { kind: 'lake', geometry, managerAvailable: false });
        expect(noManager.open()).toBe(true);
        expect(noManager.lakeError.hidden).toBe(false);
        expect(noManager.lakeSave.disabled).toBe(true);
        noManager.cancel();

        const noAdapter = makeEditorHarness(null, { kind: 'lake', geometry, adapterAvailable: false });
        expect(noAdapter.open()).toBe(true);
        expect(noAdapter.lakeError.hidden).toBe(false);
        expect(noAdapter.lakeSave.disabled).toBe(true);
        noAdapter.cancel();
    });

    it('edits and saves a lake boundary with freshly derived graphics', () => {
        const originalRing = [[0, 0], [1, 0], [1, 1], [0, 1]];
        const geometry = { type: 'Polygon', coordinates: [[...originalRing, originalRing[0]]] };
        const harness = makeEditorHarness(null, {
            kind: 'lake', geometry,
            lakeGraphics: { geometry, shore: { type: 'Polygon', coordinates: [] }, water: null, version: 'stale' }
        });
        const editedRing = [[0, 0], [1.25, 0], [1, 1], [0, 1]];

        expect(harness.open()).toBe(true);
        expect(harness.panel.innerHTML).toContain('Lake boundary editor');
        expect(harness.panel.innerHTML).not.toContain('data-tool=');
        expect(harness.polygonEditorOptions.ring).toEqual([...originalRing, originalRing[0]]);
        expect(harness.polygonEditorOptions.undoTitle).toBe('Undo lake boundary edit');
        expect(harness.polygonEditorOptions.onCommit({ ring: editedRing, reason: 'move' })).toBe(true);

        const saved = harness.save().structureProposal;
        expect(saved.kind).toBe('lake');
        expect(saved.geometry.coordinates[0]).toEqual([...editedRing, editedRing[0]]);
        expect(saved.lakeGraphics.version).toBe('fresh');
        expect(saved.lakeGraphics.geometry).toEqual(saved.geometry);
        expect(saved).not.toHaveProperty('decorations');
        expect(harness.polygonEditorDestroyed).toBe(true);
        expect(harness.finishedDrafts).toEqual(['draft-1']);
    });

    it('keeps lake boundary edits cancellable and routes undo commits back into the outline', () => {
        const originalRing = [[0, 0], [1, 0], [1, 1], [0, 1]];
        const geometry = { type: 'Polygon', coordinates: [[...originalRing, originalRing[0]]] };
        const harness = makeEditorHarness(null, { kind: 'lake', geometry });
        const movedRing = [[0, 0], [1.2, 0], [1, 1], [0, 1]];

        expect(harness.open()).toBe(true);
        harness.polygonEditorOptions.onCommit({ ring: movedRing, reason: 'move' });
        harness.polygonEditorOptions.onCommit({ ring: originalRing, reason: 'undo' });
        expect(harness.polygonEditorOptions.onCommit({ ring: originalRing, reason: 'undo' })).toBe(true);
        harness.cancel();

        expect(harness.savedPayload).toBeNull();
        expect(harness.draft.editorPayload.structureProposal.geometry).toEqual(geometry);
        expect(harness.polygonEditorDestroyed).toBe(true);
    });

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
