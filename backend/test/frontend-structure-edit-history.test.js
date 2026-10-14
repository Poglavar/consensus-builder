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
    const initialMapDraggingEnabled = options.mapDraggingEnabled !== false;
    const groundRecords = [];
    const lakeError = { hidden: true, textContent: '' };
    const lakeSave = { disabled: false };
    const finishButton = { hidden: true, disabled: true };
    const undoButton = {
        disabled: true, attributes: {}, listeners: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(type, handler) { this.listeners[type] = handler; },
        removeEventListener(type) { delete this.listeners[type]; },
        fire() { this.listeners.click?.(); }
    };
    const groups = [];
    const previewLayers = [];
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
            if (selector === '[data-action="undo"]') return undoButton;
            return /finish-path/.test(selector) ? finishButton : (/data-role/.test(selector) ? element : null);
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
        fire(type, event = {}) { (documentHandlers.get(type) || []).slice().forEach(handler => handler(event)); },
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
        fire(type, event = {}) { (mapHandlers.get(type) || []).slice().forEach(handler => handler(event)); },
        dragging: {
            _enabled: initialMapDraggingEnabled,
            enable() { this._enabled = true; },
            disable() { this._enabled = false; },
            enabled() { return this._enabled; }
        },
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
    const makeLayer = options => ({
        options,
        events: {},
        addTo(group) { group.addLayer(this); return this; },
        on(type, handler) { this.events[type] = handler; return this; },
        fire(type, event = {}) { this.events[type]?.(event); return this; },
        setLatLngs(latlngs) { this.latlngs = latlngs; return this; },
        setStyle(style) { this.style = { ...this.style, ...style }; return this; }
    });
    const markers = [];
    const L = {
        layerGroup: groupFactory,
        geoJSON(_feature, options) {
            const layer = Object.assign(makeLayer(options), { getBounds: () => ({ isValid: () => true }) });
            previewLayers.push(layer);
            return layer;
        },
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
        polygon(_latlngs, options) {
            const layer = makeLayer(options);
            previewLayers.push(layer);
            return layer;
        },
        polyline(_latlngs, options) {
            const layer = makeLayer(options);
            previewLayers.push(layer);
            return layer;
        },
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
                record() { snapshots.push(JSON.parse(JSON.stringify(options.capture()))); announce(); },
                undo() {
                    if (!snapshots.length) return false;
                    options.restore(snapshots.pop()); announce(); return true;
                },
                bindKeyboard(target) { target.addEventListener('keydown', handler, true); },
                bindButton(button) {
                    button.addEventListener('click', () => instance.undo());
                    announce();
                },
                destroy() { snapshots.length = 0; }
            };
            function announce() {
                undoButton.disabled = snapshots.length === 0;
                undoButton.setAttribute('aria-disabled', String(snapshots.length === 0));
            }
            historyInstances.push(instance);
            return instance;
        }
    };
    let savedDecorations = null;
    let savedPayload = null;
    let syncBehavior = options.syncBehavior || 'success';
    const saveFailures = [];
    const statusMessages = [];
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
            booleanPointInPolygon(point) {
                if (options.rejectOutsidePoints !== true) return true;
                const [lng, lat] = point.coordinates;
                return lng >= 0 && lng <= 1 && lat >= 0 && lat <= 1;
            },
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
            if (syncBehavior === 'null') return null;
            if (syncBehavior === 'throw') throw new Error('draft store unavailable');
            savedPayload = payload;
            savedDecorations = payload.structureProposal.decorations;
            draft.editorPayload.structureProposal = JSON.parse(JSON.stringify(payload.structureProposal));
            return draft;
        },
        reportProposalDesignSaveFailure(error) { saveFailures.push(error || null); },
        finishProposalDraftDesignSession(id) { finishedDrafts.push(id); return options.finishFailed ? null : draft; },
        updateStatus(message) { statusMessages.push(message); context.lastStatus = message; },
        isProposalDesignCommitSession() { return options.commitSession === true; },
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
                    hints: [],
                    setHint(value) { this.hints.push(value); },
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
        context, panel, groups, markers, previewLayers, historyInstances, document,
        undoButton, finishButton,
        draft,
        groundRecords,
        lakeError,
        lakeSave,
        get polygonEditorOptions() { return polygonEditorOptions; },
        get polygonEditorDestroyed() { return polygonEditorDestroyed; },
        get finishedDrafts() { return finishedDrafts; },
        get savedPayload() { return savedPayload; },
        mapEditorOptions, mapEditorSessions, fitFeatures,
        saveFailures, statusMessages,
        setSyncBehavior(value) { syncBehavior = value; },
        fireMap: (type, event) => map.fire(type, event),
        fireDocument: (type, event) => document.fire(type, event),
        listenerCount(target, type) {
            return (target === 'map' ? mapHandlers : documentHandlers).get(type)?.length || 0;
        },
        isMapDraggingEnabled: () => map.dragging.enabled(),
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

const currentMarkers = harness => harness.groups.at(-1).items.filter(item => typeof item.getLatLng === 'function');

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

        expect(harness.undoButton.disabled).toBe(false);
        harness.undoButton.fire();
        expect(currentMarkers(harness)).toHaveLength(1);
        expect(harness.undoButton.disabled).toBe(true);
        expect(harness.save().trees).toEqual([[0.2, 0.2]]);
    });

    it.each([
        ['park tree', 'park', { trees: [] }, 'tree', 'trees'],
        ['square fountain', 'square', { fountains: [], trees: [], benches: [], stalls: [], statues: [] }, 'fountain', 'fountains']
    ])('undo removes a newly placed %s', (_label, kind, decorations, tool, field) => {
        const harness = makeEditorHarness(decorations, { kind });
        expect(harness.open()).toBe(true);
        harness.panel.fireClick({ tool });
        harness.fireMap('click', { latlng: { lng: 0.2, lat: 0.2 } });
        expect(currentMarkers(harness)).toHaveLength(1);
        expect(harness.undoButton.disabled).toBe(false);

        harness.undoButton.fire();

        expect(currentMarkers(harness)).toHaveLength(0);
        expect(harness.save()[field]).toEqual([]);
    });

    it('keeps a contextual hint and path completion available in the shared footer', () => {
        const harness = makeEditorHarness({ paths: [] }, { kind: 'park' });
        expect(harness.open()).toBe(true);
        expect(harness.panel.innerHTML).not.toContain('data-role="hint"');
        expect(harness.panel.innerHTML).toContain('data-action="finish-path"');
        expect(harness.mapEditorSessions[0].hints.at(-1)).toBe('Select an item to begin.');

        harness.panel.fireClick({ tool: 'path' });
        expect(harness.finishButton.hidden).toBe(false);
        expect(harness.finishButton.disabled).toBe(true);
        expect(harness.mapEditorSessions[0].hints.at(-1)).toBe('Footpath: Click to add path points, then choose Finish path.');

        harness.fireMap('click', { latlng: { lng: 0.2, lat: 0.2 } });
        harness.fireMap('click', { latlng: { lng: 0.4, lat: 0.4 } });
        expect(harness.finishButton.disabled).toBe(false);
        harness.panel.fireClick({ action: 'finish-path' });
        expect(harness.finishButton.hidden).toBe(false);
        expect(harness.finishButton.disabled).toBe(true);
        expect(harness.save().paths).toEqual([[[0.2, 0.2], [0.4, 0.4]]]);
    });

    it('undoes individual path points and restores unfinished points after Finish path', () => {
        const harness = makeEditorHarness({ paths: [] }, { kind: 'park' });
        expect(harness.open()).toBe(true);
        harness.panel.fireClick({ tool: 'path' });
        harness.fireMap('click', { latlng: { lng: 0.2, lat: 0.2 } });
        harness.fireMap('click', { latlng: { lng: 0.4, lat: 0.4 } });
        expect(harness.finishButton.disabled).toBe(false);

        harness.undoButton.fire();
        expect(harness.finishButton.disabled).toBe(true); // The second point was removed.
        harness.fireMap('click', { latlng: { lng: 0.4, lat: 0.4 } });
        harness.panel.fireClick({ action: 'finish-path' });
        expect(harness.finishButton.disabled).toBe(true);

        harness.undoButton.fire();
        expect(harness.finishButton.disabled).toBe(false); // Undo restored the unfinished path.
        expect(harness.save().paths).toEqual([[[0.2, 0.2], [0.4, 0.4]]]);
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

    it.each([
        ['park tree', 'park', { trees: [[0.2, 0.2]] }, 'trees', [[0.4, 0.35]]],
        ['park bench', 'park', { benches: [{ coordinate: [0.2, 0.2], bearing: 15 }] }, 'benches', [{ coordinate: [0.4, 0.35], bearing: 15 }]],
        ['square fountain', 'square', { fountains: [[0.2, 0.2]] }, 'fountains', [[0.4, 0.35]]]
    ])('keeps the latest valid %s coordinate after a later out-of-bound drag', (_label, kind, decorations, type, expected) => {
        const harness = makeEditorHarness(decorations, { kind, rejectOutsidePoints: true });
        expect(harness.open()).toBe(true);
        expect(harness.context.turf.booleanPointInPolygon(harness.context.turf.point([0.4, 0.35]))).toBe(true);
        const marker = currentMarkers(harness)[0];

        marker.setLatLng([0.35, 0.4]);
        marker.fire('dragend');
        expect(marker.getLatLng()).toEqual({ lat: 0.35, lng: 0.4 });

        marker.setLatLng([1.2, 1.3]); // Outside the authored [0, 1] boundary.
        marker.fire('dragend');

        expect(marker.getLatLng()).toEqual({ lat: 0.35, lng: 0.4 });
        expect(harness.save()[type]).toEqual(expected);
    });

    it.each(['null', 'throw'])('keeps the park editor open after draft sync %s and preserves edits for retry', (syncBehavior) => {
        const harness = makeEditorHarness({ trees: [[0.2, 0.2]], version: 3 }, { syncBehavior });
        expect(harness.open()).toBe(true);
        const marker = currentMarkers(harness)[0];
        marker.setLatLng([0.35, 0.4]);
        marker.fire('dragend');

        harness.save();

        expect(harness.context.isStructureGeometryEditorActive()).toBe(true);
        expect(harness.finishedDrafts).toEqual([]);
        expect(harness.savedPayload).toBeNull();
        expect(harness.statusMessages).not.toContain('Structure design saved.');
        expect(harness.saveFailures).toHaveLength(1);
        if (syncBehavior === 'throw') expect(harness.saveFailures[0].message).toBe('draft store unavailable');

        harness.setSyncBehavior('success');
        const saved = harness.save();
        expect(saved.trees).toEqual([[0.4, 0.35]]);
        expect(harness.savedPayload.structureProposal.decorations.trees).toEqual([[0.4, 0.35]]);
        expect(harness.context.isStructureGeometryEditorActive()).toBe(false);
        expect(harness.finishedDrafts).toEqual(['draft-1']);
        expect(harness.statusMessages).toContain('Structure design saved.');
    });

    it('keeps the editable design when its draft cannot be read at save time', () => {
        const harness = makeEditorHarness({ trees: [[0.2, 0.2]] });
        expect(harness.open()).toBe(true);
        harness.context.proposalDraftStore.getDraft = () => null;

        harness.save();

        expect(harness.context.isStructureGeometryEditorActive()).toBe(true);
        expect(harness.finishedDrafts).toEqual([]);
        expect(harness.saveFailures).toHaveLength(1);
    });

    it('discards a retained commit-session draft on Cancel without publishing it', () => {
        const harness = makeEditorHarness({ trees: [[0.2, 0.2]] }, { commitSession: true });
        let discarded = false;
        const published = [];
        harness.draft.dirty = true;
        harness.context.discardProposalDraftDesignSession = () => {
            discarded = true;
            harness.context.isProposalDesignCommitSession = () => false;
        };
        harness.context.finishProposalDraftDesignSession = () => {
            if (harness.context.isProposalDesignCommitSession()) published.push(harness.draft);
        };
        expect(harness.open()).toBe(true);

        harness.cancel();

        expect(discarded).toBe(true);
        expect(published).toEqual([]);
        expect(harness.context.isStructureGeometryEditorActive()).toBe(false);
    });

    it('does not overwrite a failed draft finish with a saved status', () => {
        const harness = makeEditorHarness({ trees: [[0.2, 0.2]] }, { finishFailed: true });
        expect(harness.open()).toBe(true);

        harness.save();

        expect(harness.finishedDrafts).toEqual(['draft-1']);
        expect(harness.statusMessages).not.toContain('Structure design saved.');
    });

    it('does not report local success while saving a valid commit-session draft', () => {
        const harness = makeEditorHarness({ trees: [[0.2, 0.2]], version: 3 }, { commitSession: true });
        expect(harness.open()).toBe(true);
        const marker = currentMarkers(harness)[0];
        marker.setLatLng([0.35, 0.4]);
        marker.fire('dragend');

        expect(harness.save().trees).toEqual([[0.4, 0.35]]);
        expect(harness.finishedDrafts).toEqual(['draft-1']);
        expect(harness.statusMessages).not.toContain('Structure design saved.');
    });

    it.each([
        ['park', { trees: [[0.2, 0.2]], paths: [[[0.1, 0.1], [0.4, 0.4]]] }, 'trees'],
        ['square', { fountains: [[0.2, 0.2]] }, 'fountains']
    ])('keeps %s point handles above SVG previews and saves dragged coordinates', (kind, decorations, type) => {
        const harness = makeEditorHarness(decorations, { kind });

        expect(harness.open()).toBe(true);
        const marker = currentMarkers(harness)[0];
        expect(marker.options.pane).toBe('onMapEditorHandles');
        expect(marker.options.zIndexOffset).toBeUndefined();
        expect(harness.previewLayers.some(layer => layer.options?.pane === 'onMapEditorPane')).toBe(true);

        marker.fire('dragstart');
        marker.setLatLng([0.35, 0.4]); // Leaflet marker coordinates are [latitude, longitude].
        marker.fire('dragend');

        expect(harness.save()[type]).toEqual([[0.4, 0.35]]);
    });

    it.each([
        ['map', true],
        ['document', false]
    ])('ends a park path drag on %s touchcancel and restores its original map drag state', (cancelTarget, wasEnabled) => {
        const harness = makeEditorHarness({ paths: [[[0.1, 0.2], [0.4, 0.5]]] }, {
            mapDraggingEnabled: wasEnabled
        });

        expect(harness.open()).toBe(true);
        const path = harness.previewLayers.find(layer => layer.options?.className === 'structure-geometry-draggable');
        expect(path).toBeDefined();
        const activeListenersBeforeDrag = {
            map: ['mousemove', 'touchmove', 'mouseup', 'touchend', 'touchcancel']
                .map(type => harness.listenerCount('map', type)),
            document: ['mouseup', 'touchend', 'touchcancel']
                .map(type => harness.listenerCount('document', type))
        };
        path.fire('touchstart', { latlng: { lng: 0.1, lat: 0.2 }, originalEvent: {} });
        expect(harness.isMapDraggingEnabled()).toBe(false);
        expect(harness.listenerCount('map', 'touchmove')).toBe(1);
        expect(harness.listenerCount('document', 'touchend')).toBe(1);

        harness.fireMap('touchmove', { latlng: { lng: 0.3, lat: 0.4 } });
        expect(path.latlngs).toEqual([[0.4, 0.3], [0.7, 0.6]]);
        if (cancelTarget === 'map') harness.fireMap('touchcancel');
        else harness.fireDocument('touchcancel');

        expect(['mousemove', 'touchmove', 'mouseup', 'touchend', 'touchcancel']
            .map(type => harness.listenerCount('map', type))).toEqual(activeListenersBeforeDrag.map);
        expect(['mouseup', 'touchend', 'touchcancel']
            .map(type => harness.listenerCount('document', type))).toEqual(activeListenersBeforeDrag.document);
        expect(harness.isMapDraggingEnabled()).toBe(wasEnabled);
    });

    it('does not enable a map that was disabled before a completed park touch drag', () => {
        const harness = makeEditorHarness({ paths: [[[0.1, 0.2], [0.4, 0.5]]] }, {
            mapDraggingEnabled: false
        });

        expect(harness.open()).toBe(true);
        const path = harness.previewLayers.find(layer => layer.options?.className === 'structure-geometry-draggable');
        path.fire('touchstart', { latlng: { lng: 0.1, lat: 0.2 }, originalEvent: {} });
        harness.fireDocument('touchend');

        expect(harness.isMapDraggingEnabled()).toBe(false);
        expect(harness.listenerCount('map', 'touchmove')).toBe(0);
        expect(harness.listenerCount('document', 'touchend')).toBe(0);
    });
});
