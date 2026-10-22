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
        classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
        appendChild(child) { child.remove?.(); child.parentNode = this; this.children.push(child); return child; },
        insertBefore(child, next) {
            child.remove?.(); child.parentNode = this;
            const at = this.children.indexOf(next);
            this.children.splice(at < 0 ? this.children.length : at, 0, child);
            return child;
        },
        remove() {
            this.isConnected = false;
            const siblings = this.parentNode?.children || [];
            const index = siblings.indexOf(this);
            if (index >= 0) siblings.splice(index, 1);
        },
        contains(target) { return this === target || this.children.some(child => child.contains?.(target)); },
        focus: vi.fn(),
        setAttribute(name, value) { this.attributes[name] = String(value); },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 500 })
    };
}

function runtime({ claim = true, popup = false } = {}) {
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
    const mapContainer = fakeElement();
    mapContainer.getBoundingClientRect = () => ({ left: 30, top: 20, width: 1000, height: 800 });
    const mapListeners = new Map();
    const map = {
        panes: new Map(),
        on: vi.fn((names, fn) => names.split(' ').forEach(name => {
            if (!mapListeners.has(name)) mapListeners.set(name, new Set());
            mapListeners.get(name).add(fn);
        })),
        off: vi.fn((names, fn) => names.split(' ').forEach(name => mapListeners.get(name)?.delete(fn))),
        fire(name, event = {}) { mapListeners.get(name)?.forEach(fn => fn(event)); },
        closePopup: vi.fn(function (popup) { this.fire('popupclose', { popup }); }),
        invalidateSize: vi.fn(),
        fitBounds: vi.fn(),
        getPane(name) { return this.panes.get(name) || null; },
        createPane(name) {
            const pane = { style: {} };
            this.panes.set(name, pane);
            return pane;
        },
        latLngToContainerPoint: () => ({ x: 300, y: 200 }),
        getContainer: () => mapContainer
    };
    if (popup) {
        const mapPane = fakeElement();
        mapPane.getBoundingClientRect = () => ({ left: -18, top: 32 });
        mapContainer.appendChild(mapPane);
        const popupPane = fakeElement();
        popupPane.style.left = '0px'; popupPane.style.top = '0px';
        mapPane.appendChild(popupPane);
        map.panes.set('mapPane', mapPane);
        map.panes.set('popupPane', popupPane);
    }
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
    it('uses the global view buttons and keeps mode hints and guards in sync', () => {
        const { editor, env, buttons, envListeners } = runtime();
        const session = editor.open({
            owner: 'row-house',
            modes: ['2d', 'model'],
            hints: { '2d': 'Edit the footprint on the map.', model: 'Edit the footprint in 3D.' }
        });

        expect(session.content.children.map(child => child.className)).toEqual([
            'on-map-editor__hint', 'on-map-editor__body'
        ]);
        expect(editor.allowsMode('2d')).toBe(true);
        expect(editor.allowsMode('model')).toBe(true);
        expect(editor.allowsMode('photo')).toBe(false);
        expect(session.content.children[0].textContent).toBe('Edit the footprint on the map.');

        env.__mapModeState.desired = 'model';
        env.isThreeModeActive = () => true;
        envListeners.get('mapmodechange')();
        expect(session.content.children[0].textContent).toBe('Edit the footprint in 3D.');
        session.close();
    });

    it('collapses controls without hiding the editing hint, actions or map tools', () => {
        const { editor, env, map, envListeners } = runtime();
        env.innerWidth = 390;
        const actions = fakeElement('div');
        actions.id = 'rowhouse-controls';
        const session = editor.open({
            owner: 'row-house', id: 'rowhouse', title: 'Row houses', content: 'Parameters', footer: actions, tools: 'Rotate',
            hints: { '2d': 'Drag the footprint.', model: 'Inspect the building.' }
        });
        expect(session.body.id).not.toBe(actions.id);
        const preview = { draftPreview: { kind: 'buildings', features: [] } };
        session.setPreview(preview);
        session.setAnchor({ lat: 1, lng: 2 });
        const toggle = session.panel.children[0].children.find(child => child.attributes['aria-controls'] === session.body.id);
        expect(toggle.attributes['aria-expanded']).toBe('true');
        toggle.addEventListener.mock.calls.find(([name]) => name === 'click')[1]();
        expect(session.collapsed).toBe(true);
        expect(session.body.hidden).toBe(true);
        expect(session.content.hidden).toBe(false);
        expect(session.content.children[0].textContent).toBe('Drag the footprint.');
        expect(session.footer.hidden).toBe(false);
        expect(session.tools.hidden).toBe(false);
        expect(toggle.attributes['aria-expanded']).toBe('false');
        expect(editor.getPreview()).toBe(preview);
        expect(map.fitBounds).not.toHaveBeenCalled();

        env.__mapModeState.desired = 'model';
        env.isThreeModeActive = () => true;
        envListeners.get('mapmodechange')();
        expect(session.collapsed).toBe(true);
        expect(session.content.children[0].textContent).toBe('Inspect the building.');
        session.setCollapsed(false);
        expect(session.body.hidden).toBe(false);
        expect(toggle.attributes['aria-expanded']).toBe('true');
        session.close();
    });

    it('moves keyboard focus out of hidden controls and leaves the edit intact', () => {
        const { editor, env } = runtime();
        const onCancel = vi.fn();
        const session = editor.open({ owner: 'single-building', onCancel });
        const input = fakeElement('input');
        session.body.appendChild(input);
        env.document.activeElement = input;
        session.setCollapsed(true);
        const toggle = session.panel.children[0].children.find(child => child.attributes['aria-controls'] === session.body.id);
        expect(toggle.focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(onCancel).not.toHaveBeenCalled();
        expect(editor.isActive()).toBe(true);
        session.close();
    });

    it('keeps an active-tool hint visible while controls are collapsed and after a mode repaint', () => {
        const { editor, envListeners } = runtime();
        const session = editor.open({ owner: 'park', hints: { '2d': 'Choose an item.' } });
        session.setHint('Tree · Click inside the boundary to place it.');
        session.setCollapsed(true);
        envListeners.get('mapmodechange')();
        expect(session.content.children[0].hidden).toBe(false);
        expect(session.content.children[0].textContent).toBe('Tree · Click inside the boundary to place it.');
        session.setHint(null);
        expect(session.content.children[0].textContent).toBe('Choose an item.');
        session.close();
    });

    it('keeps anchored tools hidden until geometry is ready, and hides them when it is cleared', () => {
        const { editor } = runtime();
        const session = editor.open({ owner: 'row-house', tools: 'rotate' });
        expect(session.tools.hidden).toBe(true);
        session.setAnchor({ lat: 1, lng: 2 });
        expect(session.tools.hidden).toBe(false);
        expect(session.tools.style.left).toMatch(/px$/);
        session.setAnchor(null);
        expect(session.tools.hidden).toBe(true);
        session.close();
    });

    it('keeps anchored tools clear of the map-mode buttons on narrow screens', () => {
        const { editor, env, map, buttons } = runtime();
        env.innerWidth = 320;
        buttons['mode-2d-toggle'].getBoundingClientRect = () => ({ left: 8, right: 52, top: 400, bottom: 444 });
        map.latLngToContainerPoint = () => ({ x: 0, y: 380 });
        const session = editor.open({ owner: 'row-house', tools: 'rotate' });
        session.panel.getBoundingClientRect = () => ({ left: 60, right: 312, width: 252, top: 472 });
        session.setAnchor({ lat: 1, lng: 2 });
        expect(session.tools.hidden).toBe(false);
        expect(Number.parseFloat(session.tools.style.left)).toBeGreaterThanOrEqual(60);
        expect(Number.parseFloat(session.tools.style.left) + 160).toBeLessThanOrEqual(308);
        session.close();
    });

    it('keeps anchored tools beside a left-docked 3D panel', () => {
        const { editor } = runtime();
        const session = editor.open({ owner: 'row-house', tools: 'rotate' });
        session.panel.getBoundingClientRect = () => ({ left: 60, right: 380, width: 320, top: 76 });
        session.setAnchor({ lat: 1, lng: 2 });
        expect(Number.parseFloat(session.tools.style.left)).toBeGreaterThanOrEqual(392);
        session.close();
    });

    it('lifts native popups over editor controls, follows the map origin and restores their pane', () => {
        const { editor, map } = runtime({ popup: true });
        const popupPane = map.getPane('popupPane');
        const mapPane = map.getPane('mapPane');
        const session = editor.open({ owner: 'reparcellization' });
        expect(popupPane.parentNode).toBe(map.getContainer());
        expect(popupPane.classList.add).toHaveBeenCalledWith('on-map-editor-popups');
        expect(popupPane.style).toMatchObject({ left: '-48px', top: '12px' });
        mapPane.getBoundingClientRect = () => ({ left: 10, top: 80 });
        map.fire('move');
        expect(popupPane.style).toMatchObject({ left: '-20px', top: '60px' });
        session.close();
        expect(popupPane.parentNode).toBe(mapPane);
        expect(popupPane.style).toMatchObject({ left: '0px', top: '0px' });
        expect(popupPane.classList.remove).toHaveBeenCalledWith('on-map-editor-popups');
        map.fire('move');
        expect(popupPane.style).toMatchObject({ left: '0px', top: '0px' });
        expect(map.closePopup).toHaveBeenCalledTimes(2);
    });

    it('pans popups clear of desktop controls and restores their original padding', () => {
        const { editor, map } = runtime({ popup: true });
        const session = editor.open({ owner: 'reparcellization', tools: 'tools' });
        session.panel.getBoundingClientRect = () => ({ width: 320 });
        session.tools.hidden = false;
        session.tools.getBoundingClientRect = () => ({ bottom: 240 });
        const popup = {
            options: { autoPanPaddingTopLeft: [5, 5], autoPanPaddingBottomRight: null },
            getElement: () => ({ getBoundingClientRect: () => ({ width: 280, height: 390 }) }),
            update: vi.fn()
        };
        map.fire('popupopen', { popup });
        expect(popup.options.autoPanPaddingTopLeft).toEqual([12, 232]);
        expect(popup.options.autoPanPaddingBottomRight).toEqual([344, 100]);
        expect(popup.update).toHaveBeenCalledOnce();
        map.fire('popupclose', { popup });
        expect(popup.options.autoPanPaddingTopLeft).toEqual([5, 5]);
        expect(popup.options.autoPanPaddingBottomRight).toBeNull();
        session.close();
    });

    it('dismisses the open map popup before cancelling a geometry editor', () => {
        const { editor, map, documentListeners } = runtime({ popup: true });
        const onCancel = vi.fn();
        const session = editor.open({ owner: 'single-building', onCancel });
        const popup = {};
        map.fire('popupopen', { popup });
        const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
        documentListeners.get('keydown')(event);
        expect(map.closePopup).toHaveBeenLastCalledWith(popup);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).toHaveBeenCalledOnce();
        expect(onCancel).not.toHaveBeenCalled();
        documentListeners.get('keydown')(event);
        expect(onCancel).toHaveBeenCalledOnce();
        session.close();
    });

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
        env.document.querySelectorAll = selector => selector === '.cb-dialog-overlay' ? [overlay] : [];
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

    it('leaves Escape to a sheet opened above the editor', () => {
        const { editor, env, documentListeners } = runtime();
        const onCancel = vi.fn();
        const session = editor.open({ owner: 'station', onCancel });
        const sheet = { getClientRects: () => [{}] };
        env.document.querySelectorAll = selector => selector.startsWith('.map-sheet') ? [sheet] : [];
        const event = { key: 'Escape', preventDefault: vi.fn() };
        documentListeners.get('keydown')(event);
        expect(onCancel).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
        sheet.getClientRects = () => [];
        documentListeners.get('keydown')(event);
        expect(onCancel).toHaveBeenCalledOnce();
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

    it('fits below a desktop tool card too, leaving room for its drawing row', () => {
        const { editor, env, map } = runtime();
        env.innerWidth = 1440;
        env.innerHeight = 900;
        const session = editor.open({ owner: 'reparcellization', reserveToolsSpace: true, tools: 'tools' });
        session.panel.getBoundingClientRect = () => ({ top: 76, width: 480 });
        session.tools.getBoundingClientRect = () => ({ bottom: 260 });
        session.fitFeature({ type: 'Feature' });
        expect(map.fitBounds).toHaveBeenCalledWith(expect.anything(), {
            paddingTopLeft: [48, 316], paddingBottomRight: [528, 100], maxZoom: 21, animate: false
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
        // The view tiles are map-mode-loader's to lock (paintModeLocks reads allowsMode); the
        // editor leaves them as they were.
        expect(buttons['mode-realistic-toggle'].disabled).toBe(false);
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
