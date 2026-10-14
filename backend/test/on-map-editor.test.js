import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRuntime } = require('../../frontend/js/on-map-editor.js');

function fakeElement(tagName = 'div') {
    return {
        tagName,
        children: [],
        dataset: {},
        style: {},
        attributes: {},
        hidden: false,
        disabled: false,
        isConnected: false,
        className: '',
        classList: { add: vi.fn(), remove: vi.fn() },
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
        remove() {
            this.isConnected = false;
            const siblings = this.parentNode?.children || [];
            const index = siblings.indexOf(this);
            if (index >= 0) siblings.splice(index, 1);
        },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 500 })
    };
}

function runtime({ claim = true } = {}) {
    const dispatched = [];
    const documentListeners = new Map();
    const envListeners = new Map();
    const buttons = {
        'mode-2d-toggle': fakeElement('button'),
        'mode-3d-toggle': fakeElement('button'),
        'mode-realistic-toggle': fakeElement('button'),
        'mode-ai-toggle': fakeElement('button')
    };
    buttons['mode-realistic-toggle'].disabled = false;
    buttons['mode-ai-toggle'].disabled = true;
    const suspendedPanels = [fakeElement('div'), fakeElement('aside')];
    suspendedPanels.forEach(panel => { panel.isConnected = true; });
    suspendedPanels[0].style.display = 'grid';
    suspendedPanels[1].style.display = '';
    const body = fakeElement('body');
    body.classList = { add: vi.fn(), remove: vi.fn() };
    const document = {
        body,
        activeElement: null,
        createElement: tag => fakeElement(tag),
        getElementById: id => buttons[id] || null,
        querySelectorAll: selector => selector.includes('create-proposal-modal') ? suspendedPanels : [],
        dispatchEvent: event => { dispatched.push(event.type); return true; },
        addEventListener(name, listener) { documentListeners.set(name, listener); },
        removeEventListener(name) { documentListeners.delete(name); }
    };
    const map = {
        panes: new Map(),
        on: vi.fn(),
        off: vi.fn(),
        invalidateSize: vi.fn(),
        fitBounds: vi.fn(),
        getPane(name) { return this.panes.get(name) || null; },
        createPane(name) {
            const pane = { style: {} };
            this.panes.set(name, pane);
            return pane;
        },
        getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }) })
    };
    const env = {
        document,
        CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
        map,
        innerWidth: 1200,
        innerHeight: 900,
        L: { geoJSON: () => ({ getBounds: () => ({ isValid: () => true }) }) },
        __mapModeState: { desired: '2d' },
        __mapEditLock: { claim: vi.fn(() => claim), release: vi.fn() },
        addEventListener(name, listener) { envListeners.set(name, listener); },
        removeEventListener(name) { envListeners.delete(name); },
        requestMapMode: vi.fn(),
        isThreeModeActive: () => false
    };
    const editor = createRuntime(env);
    return { editor, env, map, buttons, suspendedPanels, dispatched, documentListeners, envListeners };
}

afterEach(() => vi.restoreAllMocks());

describe('OnMapEditor shared floating-panel lifecycle', () => {
    it('defers initial framing until a 2D-only editor leaves the model view', () => {
        const { editor, env, map, envListeners } = runtime();
        env.__mapModeState.desired = 'model';
        env.isThreeModeActive = () => true;
        const session = editor.open({ owner: 'station', modes: ['2d'] });
        session.fitFeature({ type: 'Feature' }, { maxZoom: 20 });
        expect(map.fitBounds).not.toHaveBeenCalled();
        env.__mapModeState.desired = '2d';
        env.isThreeModeActive = () => false;
        envListeners.get('mapmodechange')();
        expect(map.fitBounds).toHaveBeenCalledOnce();
        expect(map.fitBounds).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ maxZoom: 20 }));
        envListeners.get('mapmodechange')();
        expect(map.fitBounds).toHaveBeenCalledOnce();
        session.close();
    });

    it('lets visible confirmation dialogs consume Escape but ignores hidden dialog shells', () => {
        const { editor, env, documentListeners } = runtime();
        const onCancel = vi.fn();
        const session = editor.open({ owner: 'single-building', onCancel });
        const overlay = { hidden: true, getClientRects: () => [{}] };
        env.document.querySelectorAll = () => [overlay];
        const key = () => ({ key: 'Escape', preventDefault: vi.fn() });
        documentListeners.get('keydown')(key());
        expect(onCancel).toHaveBeenCalledOnce();
        overlay.hidden = false;
        documentListeners.get('keydown')(key());
        expect(onCancel).toHaveBeenCalledOnce();
        overlay.getClientRects = () => [];
        documentListeners.get('keydown')(key());
        expect(onCancel).toHaveBeenCalledTimes(2);
        session.close();
    });

    it('frames between fixed mobile tools and the dock after refreshing the map size', () => {
        const { editor, env, map } = runtime();
        env.innerWidth = 320;
        env.innerHeight = 568;
        const session = editor.open({ owner: 'reparcellization', reserveToolsSpace: true, tools: 'tools' });
        session.panel.getBoundingClientRect = () => ({ top: 306, width: 304 });
        session.tools.getBoundingClientRect = () => ({ bottom: 200 });
        session.fitFeature({ type: 'Feature' });
        expect(map.invalidateSize).toHaveBeenCalledWith({ pan: false });
        expect(map.fitBounds).toHaveBeenCalledWith(expect.anything(), {
            paddingTopLeft: [48, 208], paddingBottomRight: [24, 286], maxZoom: 21, animate: false
        });
        session.close();
    });

    it('refuses to open when the shared edit lock is unavailable', () => {
        const { editor, env } = runtime({ claim: false });
        expect(editor.open({ owner: 'row-house' })).toBeNull();
        expect(env.__mapEditLock.claim).toHaveBeenCalledWith('row-house', 'row-house');
        expect(editor.isActive()).toBe(false);
    });

    it('uses the existing map and restores shared UI state on close', () => {
        const { editor, map, env, suspendedPanels, buttons, documentListeners, envListeners } = runtime();
        const session = editor.open({ owner: 'parcel-based', modes: ['2d', 'model'] });

        expect(session.map).toBe(map);
        expect(session.pane).toBe('onMapEditorPane');
        expect(session.handlePane).toBe('onMapEditorHandles');
        expect(suspendedPanels.map(panel => panel.style.display)).toEqual(['none', 'none']);
        expect(buttons['mode-realistic-toggle'].disabled).toBe(true);
        expect(buttons['mode-ai-toggle'].disabled).toBe(true);
        expect(editor.allowsMode('model')).toBe(true);
        expect(editor.allowsMode('photo')).toBe(false);

        session.close();
        expect(map.off).toHaveBeenCalledWith('move zoom resize', expect.any(Function));
        expect(map.invalidateSize).toHaveBeenCalledWith({ pan: false });
        expect(env.__mapEditLock.release).toHaveBeenCalledWith('parcel-based');
        expect(suspendedPanels.map(panel => panel.style.display)).toEqual(['grid', '']);
        expect(buttons['mode-realistic-toggle'].disabled).toBe(false);
        expect(buttons['mode-ai-toggle'].disabled).toBe(true);
        expect(editor.isActive()).toBe(false);
        expect(documentListeners.has('keydown')).toBe(false);
        expect(envListeners.has('mapmodechange')).toBe(false);
    });

    it('releases the shared panel, lock and suspended UI when opening throws', () => {
        const { editor, map, env, suspendedPanels } = runtime();
        vi.spyOn(map, 'on').mockImplementation(() => { throw new Error('map listener failed'); });

        expect(() => editor.open({ owner: 'row-house' })).toThrow('map listener failed');
        expect(editor.isActive()).toBe(false);
        expect(env.__mapEditLock.release).toHaveBeenCalledWith('row-house');
        expect(env.document.body.children).toHaveLength(0);
        expect(env.document.body.classList.remove).toHaveBeenCalledWith('on-map-editing');
        expect(suspendedPanels.map(panel => panel.style.display)).toEqual(['grid', '']);
    });

    it('publishes preview changes and clears the active preview on close', () => {
        const { editor, dispatched } = runtime();
        const session = editor.open({ owner: 'row-house' });
        const detail = { draftPreview: { kind: 'buildings', features: [] }, envelopes: [] };

        session.setPreview(detail);
        expect(editor.getPreview()).toBe(detail);
        expect(dispatched).toEqual(['on-map-editor-preview-change']);
        session.close();
        expect(editor.getPreview()).toBeNull();
        expect(dispatched).toEqual(['on-map-editor-preview-change', 'on-map-editor-preview-change']);
    });
});
