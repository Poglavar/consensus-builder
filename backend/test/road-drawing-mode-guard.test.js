// Covers the road/track 2D-only guard, view-button restoration, cancellation, and nested editor lifecycle.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRuntime: createOnMapEditorRuntime } = require('../../frontend/js/on-map-editor.js');

const roadSource = readFileSync(fileURLToPath(new URL('../../frontend/js/road-drawing.js', import.meta.url)), 'utf8');
const modeSource = readFileSync(fileURLToPath(new URL('../../frontend/js/map-mode-loader.js', import.meta.url)), 'utf8');

function lift(source, name) {
    const functionStart = source.indexOf(`function ${name}(`);
    const start = functionStart >= 6 && source.slice(functionStart - 6, functionStart) === 'async '
        ? functionStart - 6 : functionStart;
    expect(start, `${name} not found`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n}', functionStart);
    expect(end, `${name} closing brace not found`).toBeGreaterThan(start);
    return source.slice(start, end + 2);
}

function roadLifecycle() {
    const buttons = new Map([
        ['mode-3d-toggle', { disabled: false }],
        ['mode-realistic-toggle', { disabled: true }],
        ['mode-ai-toggle', { disabled: false }]
    ]);
    const window = {};
    const document = { getElementById: id => buttons.get(id) || null };
    const exitRoadDrawingMode = vi.fn();
    const code = `
        let roadDrawingMode = false;
        let corridorDrawKind = 'road';
        let roadDrawingModeButtonState = null;
        const window = deps.window;
        const document = deps.document;
        function announceCorridorDrawingModeChange() {}
        ${lift(roadSource, 'setRoadDrawingModeButtonsDisabled')}
        ${lift(roadSource, 'updateGlobalRoadDrawingMode')}
        function exitRoadDrawingMode() { deps.exitRoadDrawingMode(); }
        ${lift(roadSource, 'discardRoadDrawing')}
        return { updateGlobalRoadDrawingMode, discardRoadDrawing };
    `;
    return { api: new Function('deps', code)({ window, document, exitRoadDrawingMode }), buttons, exitRoadDrawingMode, window };
}

function mapModeGuard(root) {
    const start = modeSource.indexOf('function canRequestMapMode(');
    const end = modeSource.indexOf('\n    }', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const helper = modeSource.slice(start, end + 6);
    return new Function('root', `${helper}; return canRequestMapMode;`)(root);
}

function loadMapModeLoader({ roadDrawingMode }) {
    const buttons = new Map(['mode-2d-toggle', 'mode-3d-toggle', 'mode-realistic-toggle', 'mode-ai-toggle']
        .map(id => [id, {
            disabled: false,
            classList: { toggle: vi.fn() },
            setAttribute: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            click: vi.fn()
        }]));
    const controller = {
        request: vi.fn(() => Promise.resolve(true)),
        getState: () => ({ desired: '2d', pending: false })
    };
    const root = {
        roadDrawingMode,
        location: { search: '' },
        appendBuildToken: path => path,
        dispatchEvent: vi.fn(),
        updateModeButtonStates: vi.fn(),
        __mapModeTransition: { createController: vi.fn(() => controller) },
        __threeModeDriver: { enter: vi.fn(), exit: vi.fn() },
        PhotorealMode: { activate: vi.fn(), deactivate: vi.fn() }
    };
    const document = {
        head: { appendChild: vi.fn() },
        getElementById: id => buttons.get(id) || null,
        createElement: () => ({ remove: vi.fn() })
    };
    new Function('window', 'document', 'CustomEvent', 'URLSearchParams', modeSource)(
        root, document, class CustomEvent { constructor(type, options) { this.type = type; Object.assign(this, options); } }, URLSearchParams
    );
    return { root, controller, buttons };
}

function sharedEditorForButtons(buttons) {
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
    return createOnMapEditorRuntime(env);
}

function seededStartThatChangesModeDuringLoad() {
    const window = {
        __mapModeState: { desired: '2d' },
        proposalDraftStore: { getDraft: vi.fn(() => ({ draftId: 'draft-1' })) },
        beginProposalDraftDesignSession: vi.fn()
    };
    const document = { body: { classList: { contains: () => false } } };
    const code = `
        let roadDrawingMode = false;
        let corridorDrawKind = 'road';
        const window = deps.window;
        const document = deps.document;
        function canStartRoadDrawingInCurrentMode() {
            const state = window.__mapModeState;
            return state?.desired === '2d';
        }
        async function ensureCorridorBuildingFootprintsLoaded() {
            window.__mapModeState.desired = 'model';
        }
        function exitRoadDrawingMode() {}
        function toggleRoadDrawTool() { throw new Error('must not enter drawing after mode changes'); }
        ${lift(roadSource, 'startSeededCorridorDrawing')}
        return startSeededCorridorDrawing;
    `;
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    return { start: new AsyncFunction('deps', code)({ window, document }), window };
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

    it('disables incompatible view buttons while drawing and restores their original states on exit', () => {
        const h = roadLifecycle();
        h.api.updateGlobalRoadDrawingMode(true);
        expect(h.window.roadDrawingMode).toBe(true);
        expect([...h.buttons.values()].map(button => button.disabled)).toEqual([true, true, true]);
        h.api.updateGlobalRoadDrawingMode(false);
        expect(h.window.roadDrawingMode).toBe(false);
        expect([...h.buttons.values()].map(button => button.disabled)).toEqual([false, true, false]);
    });

    it('restores the same view-button state when the user cancels the drawing', () => {
        const h = roadLifecycle();
        h.api.updateGlobalRoadDrawingMode(true);
        h.api.discardRoadDrawing();
        expect(h.window.roadDrawingMode).toBe(false);
        expect([...h.buttons.values()].map(button => button.disabled)).toEqual([false, true, false]);
        expect(h.exitRoadDrawingMode).toHaveBeenCalledOnce();
    });

    it('keeps mode buttons disabled across the nested cross-section editor, then restores them on road exit', () => {
        const h = roadLifecycle();
        h.api.updateGlobalRoadDrawingMode(true);
        const editor = sharedEditorForButtons(h.buttons);
        const child = editor.open({ owner: 'corridor-editor', modes: ['2d'] });
        expect(child).not.toBeNull();
        child.close();
        expect([...h.buttons.values()].map(button => button.disabled)).toEqual([true, true, true]);
        h.api.updateGlobalRoadDrawingMode(false);
        expect([...h.buttons.values()].map(button => button.disabled)).toEqual([false, true, false]);
    });

    it('refuses to start from a requested/current non-2D view', () => {
        expect(roadSource).toContain('if (!roadDrawingMode && !canStartRoadDrawingInCurrentMode()) return false;');
        expect(roadSource).toContain('if (!canStartRoadDrawingInCurrentMode()) return false;');
        const start = lift(roadSource, 'canStartRoadDrawingInCurrentMode');
        const canStart = new Function('window', 'document', `${start}; return canStartRoadDrawingInCurrentMode;`);
        const model = canStart({ __mapModeState: { desired: 'model' } }, { body: { classList: { contains: () => false } } });
        const pendingPhoto = canStart({ __mapModeState: { desired: '2d' }, __pending3DMode: 'photo' }, { body: { classList: { contains: () => false } } });
        expect(model()).toBe(false);
        expect(pendingPhoto()).toBe(false);
    });

    it('does not activate a copied draft design session if async loading moves to 3D', async () => {
        const h = seededStartThatChangesModeDuringLoad();
        h.start = await h.start;
        await expect(h.start('road', { id: 'seed' }, { draftId: 'draft-1' })).resolves.toBe(false);
        expect(h.window.beginProposalDraftDesignSession).not.toHaveBeenCalled();
        expect(h.window.pendingRoadDrawingSeed).toBeUndefined();
    });
});
