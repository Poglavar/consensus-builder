// Covers the road/track 2D-only guard, view-button restoration, cancellation, and nested editor lifecycle.
// The road side is the real road-drawing.js loaded into the fake browser world
// (helpers/road-drawing-env.js); map-mode-loader.js and on-map-editor.js are run as before.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadRoadDrawing, at } from './helpers/road-drawing-env.js';

const require = createRequire(import.meta.url);
const { createRuntime: createOnMapEditorRuntime } = require('../../frontend/js/on-map-editor.js');

const modeSource = readFileSync(fileURLToPath(new URL('../../frontend/js/map-mode-loader.js', import.meta.url)), 'utf8');

let env = null;
afterEach(() => {
    env?.dispose();
    env = null;
});

const VIEW_BUTTONS = ['mode-2d-toggle', 'mode-3d-toggle', 'mode-realistic-toggle', 'mode-ai-toggle'];

// A view tile as the page has it: a disabled flag, a tooltip, a class list and a dataset.
function tile(disabled, title) {
    const classes = new Set();
    return {
        disabled, title, dataset: {},
        classList: {
            add: name => classes.add(name), remove: name => classes.delete(name),
            toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
            contains: name => classes.has(name)
        },
        setAttribute: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), click: vi.fn()
    };
}

function mapModeGuard(root) {
    const start = modeSource.indexOf('function canRequestMapMode(');
    const end = modeSource.indexOf('\n    }', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const helper = modeSource.slice(start, end + 6);
    return new Function('root', `${helper}; return canRequestMapMode;`)(root);
}

// The real map-mode-loader.js over fake tiles. The page left 2D, 3D and AI enabled, photo disabled
// (its tiles were composing), so a restore has something to get wrong.
function loadMapModeLoader({ roadDrawingMode, OnMapEditor } = {}) {
    const buttons = new Map([
        ['mode-2d-toggle', tile(false, '2D map')],
        ['mode-3d-toggle', tile(false, '3D models')],
        ['mode-realistic-toggle', tile(true, 'Photo')],
        ['mode-ai-toggle', tile(false, 'AI render')]
    ]);
    const controller = {
        request: vi.fn(() => Promise.resolve(true)),
        getState: () => ({ desired: '2d', pending: false })
    };
    const root = {
        roadDrawingMode,
        OnMapEditor,
        location: { search: '' },
        appendBuildToken: path => path,
        dispatchEvent: vi.fn(),
        updateModeButtonStates: vi.fn(),
        __mapModeTransition: { createController: vi.fn(() => controller) },
        __threeModeDriver: { enter: vi.fn(), exit: vi.fn() },
        PhotorealMode: { activate: vi.fn(), deactivate: vi.fn() }
    };
    const documentListeners = new Map();
    const observers = [];
    const document = {
        body: {},
        head: { appendChild: vi.fn() },
        getElementById: id => buttons.get(id) || null,
        createElement: () => ({ remove: vi.fn() }),
        addEventListener: (name, listener) => documentListeners.set(name, listener)
    };
    class MutationObserver {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe(target, options) { this.target = target; this.options = options; }
    }
    new Function('window', 'document', 'CustomEvent', 'URLSearchParams', 'MutationObserver', modeSource)(
        root, document, class CustomEvent { constructor(type, options) { this.type = type; Object.assign(this, options); } },
        URLSearchParams, MutationObserver
    );
    const state = () => VIEW_BUTTONS.map(id => {
        const button = buttons.get(id);
        return { disabled: button.disabled, locked: button.classList.contains('map-mode-btn--locked'), title: button.title };
    });
    return { root, controller, buttons, document, documentListeners, observers, state };
}

const LOCKED = 'Not available while you are editing — finish or cancel first';
const AS_LEFT = [
    { disabled: false, locked: false, title: '2D map' },
    { disabled: false, locked: false, title: '3D models' },
    { disabled: true, locked: false, title: 'Photo' },
    { disabled: false, locked: false, title: 'AI render' }
];

function sharedEditorForButtons(buttons, extras = {}) {
    const listeners = new Map();
    function element() {
        return {
            children: [], style: {}, attributes: {}, hidden: false, disabled: false,
            classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
            appendChild(child) { child.remove?.(); child.parentNode = this; this.children.push(child); return child; },
            remove() {
                const children = this.parentNode?.children || [];
                const index = children.indexOf(this);
                if (index >= 0) children.splice(index, 1);
                this.parentNode = null;
            },
            setAttribute(name, value) { this.attributes[name] = String(value); },
            addEventListener: vi.fn(), removeEventListener: vi.fn(), querySelectorAll: () => [],
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 600 })
        };
    }
    const body = element();
    const document = {
        body, activeElement: null, createElement: element,
        getElementById: id => buttons.get(id) || null,
        querySelectorAll: () => [], dispatchEvent: vi.fn(),
        addEventListener(name, listener) { listeners.set(name, listener); },
        removeEventListener(name) { listeners.delete(name); }
    };
    const mapContainer = element();
    const map = {
        panes: new Map(), on: vi.fn(), off: vi.fn(), invalidateSize: vi.fn(), fitBounds: vi.fn(),
        getPane(name) { return this.panes.get(name) || null; },
        createPane(name) { const pane = { style: {} }; this.panes.set(name, pane); return pane; },
        getContainer: () => mapContainer, latLngToContainerPoint: () => ({ x: 100, y: 100 }),
        closePopup: vi.fn()
    };
    const env = {
        document, map, innerWidth: 1200, innerHeight: 900,
        CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
        __mapModeState: { desired: '2d' },
        __mapEditLock: { claim: vi.fn(() => true), release: vi.fn() },
        addEventListener(name, listener) { listeners.set(`env:${name}`, listener); },
        removeEventListener(name) { listeners.delete(`env:${name}`); },
        requestMapMode: vi.fn(), isThreeModeActive: () => false,
        L: { geoJSON: () => ({ getBounds: () => ({ isValid: () => true }) }) }
    };
    Object.assign(env, extras);
    return { editor: createOnMapEditorRuntime(env), env, document, listeners, map };
}

// The drawing tool open under `editor` (window.OnMapEditor), on a road with the pen still down.
async function roadUnderEditor(editor) {
    env = loadRoadDrawing();
    await env.api.requestCorridorDrawingTool('road');
    await env.click(at(0, 0));
    await env.click(at(100, 0));
    expect(env.session.roadHasStarted).toBe(true);
    globalThis.OnMapEditor = editor;
    return env;
}

describe('road and track drawing mode guard', () => {
    it('allows 2D but rejects model and photo requests while a corridor draft is active', () => {
        const guard = mapModeGuard({ roadDrawingMode: true, OnMapEditor: { allowsMode: () => true } });
        expect(guard('2d')).toBe(true);
        expect(guard('model')).toBe(false);
        expect(guard('photo')).toBe(false);
    });

    it('blocks real requestMapMode calls through the loaded map-mode-loader', async () => {
        const { root, controller } = loadMapModeLoader({ roadDrawingMode: true });
        await expect(root.requestMapMode('model')).resolves.toBe(false);
        await expect(root.requestMapMode('photo')).resolves.toBe(false);
        expect(controller.request).not.toHaveBeenCalled();
        await expect(root.requestMapMode('2d')).resolves.toBe(true);
        expect(controller.request).toHaveBeenCalledOnce();
        expect(controller.request).toHaveBeenCalledWith('2d', undefined);
    });

    it('continues to respect another editor’s own mode restrictions', () => {
        const guard = mapModeGuard({ roadDrawingMode: false, OnMapEditor: { allowsMode: mode => mode === '2d' } });
        expect(guard('2d')).toBe(true);
        expect(guard('photo')).toBe(false);
    });

    it('greys out the views road drawing refuses and gives the tiles back as they were', () => {
        const h = loadMapModeLoader({ roadDrawingMode: false });
        expect(h.state()).toEqual(AS_LEFT);
        h.root.roadDrawingMode = true;
        h.documentListeners.get('corridor-drawing-mode-changed')();
        expect(h.state()).toEqual([
            AS_LEFT[0],
            { disabled: true, locked: true, title: LOCKED },
            { disabled: true, locked: true, title: LOCKED },
            { disabled: true, locked: true, title: LOCKED }
        ]);
        h.root.roadDrawingMode = false;
        h.documentListeners.get('corridor-drawing-mode-changed')();
        expect(h.state()).toEqual(AS_LEFT);
    });

    it('follows the on-map editor through <body> class changes and reasserts over a view repaint', () => {
        let modes = null;
        const h = loadMapModeLoader({ OnMapEditor: { allowsMode: mode => !modes || modes.includes(mode) } });
        const [observer] = h.observers;
        expect(observer.target).toBe(h.document.body);
        expect(observer.options).toEqual({ attributes: true, attributeFilter: ['class'] });
        modes = ['2d', 'model'];
        observer.callback();
        expect(h.state().map(tile => tile.locked)).toEqual([false, false, true, true]);
        // three-mode's updateModeButtonStates rewrites the AI tile on every view change.
        h.buttons.get('mode-ai-toggle').disabled = false;
        h.buttons.get('mode-ai-toggle').title = 'AI render';
        h.root.updateModeButtonStates.mockClear();
        h.controller.getState = () => ({ desired: 'model', pending: false });
        h.root.__mapModeTransition.createController.mock.calls[0][0].onChange({ desired: 'model', pending: false });
        expect(h.root.updateModeButtonStates).toHaveBeenCalledOnce();
        expect(h.state()[3]).toEqual({ disabled: true, locked: true, title: LOCKED });
        modes = null;
        observer.callback();
        expect(h.state()).toEqual(AS_LEFT);
    });

    it('drops the drawing mode and announces it when the user cancels the drawing', async () => {
        env = loadRoadDrawing();
        await env.api.requestCorridorDrawingTool('road');
        await env.click(at(0, 0));
        await env.click(at(100, 0));
        expect(globalThis.roadDrawingMode).toBe(true);
        env.api.discardRoadDrawing();
        expect(globalThis.roadDrawingMode).toBe(false);
        const announced = env.document.events.filter(event => event.type === 'corridor-drawing-mode-changed');
        expect(announced.at(-1).detail).toEqual({ road: false, kind: 'road' });
        // The tool is gone with the drawing: the panel, the handlers and the road.
        expect(env.session.roadDrawingMode).toBe(false);
        expect(env.element('road-info-panel').classList.contains('visible')).toBe(false);
        expect(env.map.listens('click')).toBe(false);
        expect(env.session.roadSegments).toEqual([]);
    });

    it('keeps the tiles locked when the nested cross-section editor closes, until the road ends', () => {
        let editorModes = null;
        const h = loadMapModeLoader({
            roadDrawingMode: true,
            OnMapEditor: { allowsMode: mode => !editorModes || editorModes.includes(mode) }
        });
        h.root.syncMapModeLocks();
        editorModes = ['2d'];
        h.observers[0].callback();
        editorModes = null;
        h.observers[0].callback();
        expect(h.state().map(tile => tile.locked)).toEqual([false, true, true, true]);
        h.root.roadDrawingMode = false;
        h.documentListeners.get('corridor-drawing-mode-changed')();
        expect(h.state()).toEqual(AS_LEFT);
    });

    it('prevents other map editors from opening during road drawing while allowing its cross-section editor', () => {
        const buttons = new Map();
        const rejected = sharedEditorForButtons(buttons, {
            roadDrawingMode: true,
            __mapEditLock: { claim: vi.fn(() => true), release: vi.fn() }
        });
        expect(rejected.editor.open({ owner: 'structure-editor' })).toBeNull();
        expect(rejected.env.__mapEditLock.claim).not.toHaveBeenCalled();
        const allowed = rejected.editor.open({ owner: 'corridor-editor', modes: ['2d'] });
        expect(allowed).not.toBeNull();
        allowed.close();
    });

    it('blocks road drawing while a shared map editor or edit lock is active', async () => {
        env = loadRoadDrawing({ globals: { OnMapEditor: { isActive: () => true } } });
        expect(env.api.canStartRoadDrawingInCurrentMode()).toBe(false);
        await expect(env.api.requestCorridorDrawingTool('road')).resolves.toBe(false);
        expect(env.session.roadDrawingMode).toBe(false);
        globalThis.OnMapEditor = undefined;
        globalThis.__mapEditLock = { isHeld: () => true };
        expect(env.api.canStartRoadDrawingInCurrentMode()).toBe(false);
        globalThis.__mapEditLock = undefined;
        expect(env.api.canStartRoadDrawingInCurrentMode()).toBe(true);
    });

    it('lets the shared editor own Escape when its listener follows the road listener', async () => {
        const { editor, listeners } = sharedEditorForButtons(new Map(), { roadDrawingMode: true });
        await roadUnderEditor(editor);
        const cancelled = vi.fn();
        const session = editor.open({ owner: 'corridor-editor', modes: ['2d'], onCancel: cancelled });
        // The road's keydown listener first (on the tool's document), then the shell's.
        const event = env.key('Escape', { stopPropagation: vi.fn() });
        listeners.get('keydown')(event);
        await env.idle();
        // The road did not lift its pen or close: the Escape was the editor's.
        expect(env.session.roadHasStarted).toBe(true);
        expect(env.session.roadDrawingMode).toBe(true);
        expect(cancelled).toHaveBeenCalledOnce();
        session.close();
    });

    it('keeps road Escape behavior when no shared editor is active', async () => {
        await roadUnderEditor({ isActive: () => false });
        const event = env.key('Escape');
        await env.idle();
        expect(event.defaultPrevented).toBe(true);
        expect(env.session.roadHasStarted).toBe(false);   // the pen was lifted
        expect(env.session.roadSegments[0]).toHaveLength(2);
    });

    it('refuses to start from a requested/current non-2D view', async () => {
        // A model view requested, and a photo switch pending: neither opens the tool.
        env = loadRoadDrawing({ globals: { __mapModeState: { desired: 'model' } } });
        await expect(env.api.requestCorridorDrawingTool('road')).resolves.toBe(false);
        expect(await env.api.startSeededCorridorDrawing('road', { centerline: [[at(0, 0), at(100, 0)]] }, null)).toBe(false);
        env.dispose();
        env = loadRoadDrawing({ globals: { __mapModeState: { desired: '2d' }, __pending3DMode: 'photo' } });
        await expect(env.api.requestCorridorDrawingTool('road')).resolves.toBe(false);
        expect(env.session.roadDrawingMode).toBe(false);
        expect(env.map.listens('click')).toBe(false);
        env.dispose();
        // The view moved to the model while the footprints loaded: asked again, after the wait.
        env = loadRoadDrawing({
            globals: {
                __mapModeState: { desired: '2d' },
                ensureCorridorBuildingFootprintsLoaded: async () => { globalThis.__mapModeState.desired = 'model'; }
            }
        });
        await expect(env.api.requestCorridorDrawingTool('road')).resolves.toBe(false);
        expect(env.session.roadDrawingMode).toBe(false);
    });

    it('does not activate a copied draft design session if async loading moves to 3D', async () => {
        env = loadRoadDrawing({
            globals: {
                __mapModeState: { desired: '2d' },
                proposalDraftStore: { getDraft: vi.fn(() => ({ draftId: 'draft-1' })) },
                ensureCorridorBuildingFootprintsLoaded: async () => { globalThis.__mapModeState.desired = 'model'; }
            }
        });
        await expect(env.api.startSeededCorridorDrawing('road', { id: 'seed' }, { draftId: 'draft-1' })).resolves.toBe(false);
        expect(globalThis.beginProposalDraftDesignSession.calls).toHaveLength(0);
        expect(globalThis.pendingRoadDrawingSeed).toBeUndefined();
        expect(env.session.roadDrawingMode).toBe(false);
    });
});
