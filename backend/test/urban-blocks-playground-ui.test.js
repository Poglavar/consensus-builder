// Headless tests for the on-map playground's panel actions, share-link UI and map layers.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const playgroundSource = readFileSync(new URL('../../frontend/js/urban-blocks-playground.js', import.meta.url), 'utf8');
const playgroundCss = readFileSync(new URL('../../frontend/css/urban-blocks-playground.css', import.meta.url), 'utf8');

function hasClass(node, className) {
    return (node.attributes.class || node.className || '').split(/\s+/).includes(className);
}

class FakeNode {
    constructor(tagName = 'div') {
        this.tagName = tagName;
        this.dataset = {};
        this.listeners = new Map();
        this.children = [];
        this.attributes = {};
        this.textContent = '';
        this.value = '';
        this.disabled = false;
        this.hidden = false;
        this.checked = false;
        this.open = false;
        this.options = [];
        this.attributes = {};
        this.className = '';
        this.classList = {
            contains: name => this.className.split(/\s+/).includes(name),
            add: () => {},
            remove: () => {},
            toggle: () => {}
        };
        this.scrollTop = 0;
        this.selected = false;
        this.readOnly = false;
    }
    addEventListener(type, callback) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(callback);
        this.listeners.set(type, listeners);
    }
    dispatch(type, event = {}) {
        const payload = { preventDefault() {}, stopPropagation() {}, target: this, ...event };
        return (this.listeners.get(type) || []).map(callback => callback(payload));
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    focus() { this.focused = true; }
    select() { this.selected = true; }
    remove() { this.removed = true; }
    contains(node) { return this.children.includes(node); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatch('close'); }
}

class FakeDialog extends FakeNode {
    constructor() {
        super('dialog');
        this.nodes = new Map();
        this.settings = {
            targetAreaM2: Object.assign(new FakeNode('input'), { value: '10000' }),
            maxSideM: Object.assign(new FakeNode('input'), { value: '150' }),
            perimeterStepM: Object.assign(new FakeNode('input'), { value: '150' })
        };
        for (const [name, node] of Object.entries(this.settings)) node.dataset.setting = name;
        this.visibility = ['showTJunctions', 'showDeadEnds', 'showPerimeter'].map(name => {
            const node = new FakeNode('input'); node.dataset.visibility = name; node.checked = true; return node;
        });
    }
    set innerHTML(value) { this.markup = value; }
    querySelector(selector) {
        const setting = selector.match(/^\[data-setting="([^"]+)"\]$/);
        if (setting) return this.settings[setting[1]];
        if (selector === '[data-slot="pieces"] [aria-pressed="true"]') return null;
        if (selector === '[data-slot="pieces"] [data-piece-id]') return null;
        if (selector === '[data-slot="pieces"]') return this.node(selector);
        if (selector === '[data-slot="target-area"]') return this.node(selector, 'p');
        if (selector === '[data-slot="metrics"]') return this.node(selector);
        if (selector === '[data-slot="legend"]') return this.node(selector);
        if (selector === '[data-action="propose"]') return this.node(selector, 'button');
        if (selector === '[data-action="share"]') return this.node(selector, 'button');
        if (selector === '[data-action="generate"]') return this.node(selector, 'button');
        if (selector === '[data-slot="layout-select"]') return this.node(selector, 'select');
        const output = selector.match(/^\[data-output="([^"]+)"\]$/);
        if (output) return this.node(selector, 'output');
        const slot = selector.match(/^\[data-slot="([^"]+)"\]$/);
        if (slot) return this.node(selector, slot[1] === 'share-link' ? 'label' : 'span');
        const action = selector.match(/^\[data-action="([^"]+)"\]$/);
        if (action) return this.node(selector, 'button');
        return this.node(selector);
    }
    querySelectorAll(selector) {
        if (selector === '[data-setting="targetAreaM2"], [data-setting="maxSideM"], [data-setting="perimeterStepM"]') return [this.settings.targetAreaM2, this.settings.maxSideM, this.settings.perimeterStepM];
        if (selector === '[data-visibility]') return this.visibility;
        if (selector === '[data-slot="pieces"] [data-piece-id]') return [];
        return [];
    }
    node(selector, tagName = 'div') {
        if (!this.nodes.has(selector)) {
            const node = new FakeNode(tagName);
            const slot = selector.match(/^\[data-slot="([^"]+)"\]$/);
            const action = selector.match(/^\[data-action="([^"]+)"\]$/);
            if (slot) node.dataset.slot = slot[1];
            if (action) node.dataset.action = action[1];
            this.nodes.set(selector, node);
        }
        return this.nodes.get(selector);
    }
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

// Leaflet as the playground uses it: every layer records its options, tooltip and handlers, and the
// one group added to the map holds what is currently drawn.
function fakeLeaflet() {
    const groups = [];
    const layer = (type, options = {}, extra = {}) => ({
        type, options: options || {}, handlers: {}, tooltip: null,
        bindTooltip(text) { this.tooltip = text; return this; },
        on(event, handler) { this.handlers[event] = handler; return this; },
        addTo(target) { target.addLayer?.(this); return this; },
        remove() { this.removed = true; },
        eachLayer(callback) { callback(this); },
        getElement() { return null; },
        setLatLng(latLng) { this.latLng = latLng; return this; },
        setContent(content) { this.content = content; return this; },
        ...extra
    });
    const L = {
        svg: options => ({ renderer: true, ...options }),
        layerGroup() {
            const group = layer('group', {}, { layers: [] });
            group.addLayer = child => { group.layers.push(child); return group; };
            group.clearLayers = () => { group.layers = []; return group; };
            group.eachLayer = callback => group.layers.forEach(callback);
            groups.push(group);
            return group;
        },
        geoJSON: (feature, options) => layer('geojson', options, { feature }),
        polyline: (latLngs, options) => layer('polyline', options, { latLngs }),
        circleMarker: (latLng, options) => layer('circle', options, { latLng }),
        marker: (latLng, options) => layer('marker', options, { latLng }),
        divIcon: options => options,
        tooltip: options => layer('tooltip', options),
        DomEvent: { stopPropagation() {} }
    };
    return { L, drawn: () => groups.find(group => group.onMap)?.layers || [] };
}

function createHarness({ clipboard = { writeText: vi.fn(() => Promise.resolve()) }, build = vi.fn(() => 'https://example.test/shared-layout'), targetAreaM2, targetSideM = 75 } = {}) {
    const dialog = new FakeDialog();
    const leaflet = fakeLeaflet();
    const map = { handlers: {}, on(event, handler) { this.handlers[event] = handler; }, off(event) { delete this.handlers[event]; },
        addLayer(layer) { layer.onMap = true; } };
    const session = { root: dialog, pane: 'onMapEditorPane', map, fitFeature: vi.fn(), close: vi.fn() };
    const editorOpen = vi.fn(() => session);
    const workers = [];
    const historyCalls = [];
    const window = {
        document: {
            body: { append() {} },
            documentElement: { lang: 'en' },
            activeElement: new FakeNode('button'),
            createElement: tag => new FakeNode(tag),
            createElementNS: (_namespace, tag) => new FakeNode(tag)
        },
        location: { href: 'https://example.test/map?city=explore' },
        history: { state: { marker: true }, replaceState: (...args) => historyCalls.push(args) },
        navigator: { clipboard },
        turf: { bbox: () => [0, 0, 1, 1] },
        UrbanBlocksLinks: { build },
        UrbanBlocksModel: { isGroundRoad: () => true },
        CityConfigManager: { getCurrentCityId: () => 'explore' },
        appendBuildToken: path => path,
        L: leaflet.L,
        OnMapEditor: { open: editorOpen },
        i18n: { t: key => key },
        CbFormat: {
            formatNumber: value => String(value),
            formatArea: value => `${value} m²`,
            formatLength: value => `${value} m`
        },
        Worker: class {
            constructor(url) { this.url = url; this.messages = []; workers.push(this); }
            postMessage(message) { this.messages.push(message); }
            terminate() { this.terminated = true; }
        }
    };
    // The on-map editor answers with a session whose root holds the panel; the fake root supplies
    // only the selectors and DOM operations that this module uses.
    runInNewContext(playgroundSource, { window, console: { warn() {} }, URL, Intl, Date, Number, String, Array, Math, JSON });
    const block = { type: 'Feature', id: 'block-1', properties: {}, geometry: {
        type: 'Polygon', coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]]
    } };
    const roads = { type: 'FeatureCollection', features: [] };
    window.UrbanBlocksPlayground.open({ block, roads, targetAreaM2, targetSideM, shareBaseUrl: 'https://example.test/map?city=explore' });
    return { dialog, workers, historyCalls, build, clipboard, window, session, editorOpen, drawn: leaflet.drawn };
}

function click(node) {
    const [result] = node.dispatch('click');
    return result;
}

function planOneLayout(harness, layouts = [{ cuts: { type: 'FeatureCollection', features: [] }, pieces: { type: 'FeatureCollection', features: [] }, stats: {} }]) {
    click(harness.dialog.querySelector('[data-action="generate"]'));
    const worker = harness.workers.at(-1);
    const request = worker.messages[0].request;
    worker.onmessage({ data: { action: 'plan', request, result: { layouts, stats: {} } } });
}

describe('urban block playground share UI', () => {
    it('shares current settings and empty cuts before Generate, putting the link in the address bar before clipboard completion', async () => {
        const copy = deferred();
        const clipboard = { writeText: vi.fn(() => copy.promise) };
        const build = vi.fn(() => 'https://example.test/shared-layout');
        const harness = createHarness({ clipboard, build });
        const button = harness.dialog.querySelector('[data-action="share"]');

        expect(button.disabled).toBe(false);
        const pending = click(button);
        const status = harness.dialog.querySelector('[data-slot="share-status"]');

        expect(build).toHaveBeenCalledWith(expect.objectContaining({
            baseUrl: 'https://example.test/map?city=explore',
            city: 'explore', blockId: 'block-1',
            subdivision: {
                options: { targetAreaM2: 5625, maxSideM: 150, perimeterStepM: 150 },
                layout: { cuts: { type: 'FeatureCollection', features: [] } }
            }
        }));
        expect(harness.historyCalls[0]).toEqual([harness.window.history.state, '', 'https://example.test/shared-layout']);
        expect(harness.dialog.querySelector('[data-output="targetAreaM2"]').textContent).toBe('5625 m²');
        expect(clipboard.writeText).toHaveBeenCalledWith('https://example.test/shared-layout');

        copy.resolve();
        await pending;
        expect(status.textContent).toContain('Layout link copied');
    });

    it('keeps a generated layout share tied to the options used to generate it', async () => {
        const build = vi.fn(() => 'https://example.test/generated-layout');
        const harness = createHarness({ build });
        planOneLayout(harness);

        const maxSide = harness.dialog.querySelector('[data-setting="maxSideM"]');
        maxSide.value = '250';
        maxSide.dispatch('input');
        await click(harness.dialog.querySelector('[data-action="share"]'));

        expect(build.mock.calls.at(-1)[0].subdivision.options).toEqual({
            targetAreaM2: 5625, maxSideM: 150, perimeterStepM: 150
        });
    });

    it('uses an area slider, formats its hard cap, and prefers area over the legacy side', () => {
        const legacy = createHarness();
        const target = legacy.dialog.querySelector('[data-setting="targetAreaM2"]');
        expect(target.value).toBe('5625');
        expect(legacy.dialog.querySelector('[data-output="targetAreaM2"]').textContent).toBe('5625 m²');
        expect(legacy.dialog.querySelector('[data-slot="target-area-label"]').textContent).toBe('Maximum block area (m²)');
        expect(legacy.dialog.querySelector('[data-slot="target-area"]').textContent).toBe('Each block must be no larger than 5625 m².');

        target.value = '12500';
        target.dispatch('input');
        expect(legacy.dialog.querySelector('[data-output="targetAreaM2"]').textContent).toBe('12500 m²');
        expect(legacy.dialog.querySelector('[data-slot="target-area"]').textContent).toBe('Each block must be no larger than 12500 m².');
        click(legacy.dialog.querySelector('[data-action="generate"]'));
        expect(legacy.workers.at(-1).messages[0].options).toEqual({ targetAreaM2: 12500, maxSideM: 150, perimeterStepM: 150 });

        const preferredArea = createHarness({ targetAreaM2: 12500, targetSideM: 200 });
        expect(preferredArea.dialog.querySelector('[data-setting="targetAreaM2"]').value).toBe('12500');
        expect(playgroundSource).toContain('type="range" min="1000" max="50000" step="125" value="10000"');
        expect(playgroundSource).toContain('for="urban-block-playground-target-area"');
    });

    it('points to the address bar after clipboard rejection or missing clipboard access', async () => {
        const rejected = createHarness({ clipboard: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) } });
        await click(rejected.dialog.querySelector('[data-action="share"]'));
        expect(rejected.historyCalls.at(-1)[2]).toBe('https://example.test/shared-layout');
        expect(rejected.dialog.querySelector('[data-slot="share-status"]').textContent).toContain('Copy the link from the address bar');

        const unavailable = createHarness({ clipboard: null });
        await click(unavailable.dialog.querySelector('[data-action="share"]'));
        expect(unavailable.historyCalls.at(-1)[2]).toBe('https://example.test/shared-layout');
        expect(unavailable.dialog.querySelector('[data-slot="share-status"]').textContent).toContain('Copy the link from the address bar');
    });

    it('clears the share status on settings or alternative changes and ignores a late clipboard result', async () => {
        const copy = deferred();
        const harness = createHarness();
        planOneLayout(harness, [
            { cuts: { type: 'FeatureCollection', features: [] }, pieces: { type: 'FeatureCollection', features: [] }, stats: {} },
            { cuts: { type: 'FeatureCollection', features: [] }, pieces: { type: 'FeatureCollection', features: [] }, stats: {} }
        ]);

        const status = harness.dialog.querySelector('[data-slot="share-status"]');
        await click(harness.dialog.querySelector('[data-action="share"]'));
        expect(status.textContent).toContain('Layout link copied');
        harness.dialog.querySelector('[data-setting="perimeterStepM"]').value = '200';
        harness.dialog.querySelector('[data-setting="perimeterStepM"]').dispatch('input');
        expect(status.textContent).toBe('');

        harness.window.navigator.clipboard.writeText = vi.fn(() => copy.promise);
        const pending = click(harness.dialog.querySelector('[data-action="share"]'));
        const alternative = harness.dialog.querySelector('[data-slot="layout-select"]');
        alternative.value = '1';
        alternative.dispatch('change', { target: alternative });

        copy.resolve();
        await pending;
        expect(status.textContent).toBe('');
    });
});

describe('urban block playground on the map', () => {
    it('opens as an on-map tool framed on the block, and closing it ends the session', () => {
        const harness = createHarness();
        expect(harness.editorOpen).toHaveBeenCalledWith(expect.objectContaining({ owner: 'urban-block-playground', modes: ['2d'] }));
        expect(harness.session.fitFeature).toHaveBeenCalledWith(expect.objectContaining({ id: 'block-1' }));
        expect(harness.drawn().map(layer => layer.options.className)).toContain('urban-block-playground__outline');

        harness.window.UrbanBlocksPlayground.close();
        expect(harness.session.close).toHaveBeenCalledTimes(1);
        expect(harness.workers.every(worker => worker.terminated)).toBe(true);
    });

    it('draws every piece and label on the map, with sidebar shades and hard-limit outlines', () => {
        const harness = createHarness();
        const pieces = [
            { type: 'Feature', id: 'piece-a', properties: { areaM2: 1200, longestSideM: 42, acceptable: true, labelPoint: [0.0003, 0.0005] }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.0005, 0], [0.0005, 0.001], [0, 0.001], [0, 0]]] } },
            { type: 'Feature', id: 'piece-b', properties: { areaM2: 1500, longestSideM: 68, acceptable: false, labelPoint: [0.0008, 0.0005] }, geometry: { type: 'Polygon', coordinates: [[[0.0005, 0], [0.001, 0], [0.001, 0.001], [0.0005, 0.001], [0.0005, 0]]] } }
        ];
        const cut = { type: 'Feature', properties: { kind: 't', lengthM: 100 }, geometry: { type: 'LineString', coordinates: [[0.0005, 0], [0.0005, 0.001]] } };
        planOneLayout(harness, [{ cuts: { type: 'FeatureCollection', features: [cut] }, pieces: { type: 'FeatureCollection', features: pieces }, stats: {} }]);

        const drawn = harness.drawn();
        const shapes = drawn.filter(layer => layer.options.className?.includes('urban-block-playground__piece '));
        expect(shapes.map(layer => layer.options.className)).toEqual([
            'urban-block-playground__piece palette-0 is-acceptable', 'urban-block-playground__piece palette-1 is-oversized'
        ]);
        expect(shapes.every(layer => layer.options.pane === 'onMapEditorPane')).toBe(true);
        expect(shapes[0].tooltip).toContain('Block 1');
        expect(shapes[0].tooltip).toContain('1200 m²');
        const labels = drawn.filter(layer => layer.type === 'marker');
        expect(labels.map(layer => layer.options.icon.html.textContent)).toEqual(['1200 m²', '1500 m²']);
        expect(labels[0].latLng).toEqual([0.0005, 0.0003]);
        expect(drawn.filter(layer => layer.options.className === 'urban-block-playground__cut is-t')).toHaveLength(1);

        const rows = harness.dialog.querySelector('[data-slot="pieces"]').children;
        const chips = rows.flatMap(row => row.children).filter(node => hasClass(node, 'urban-block-playground__piece-chip'));
        expect(chips.map(node => node.className)).toEqual(['urban-block-playground__piece-chip palette-0', 'urban-block-playground__piece-chip palette-1']);
        expect(harness.dialog.querySelector('[data-action="propose"]').disabled).toBe(false);
        expect(harness.dialog.querySelector('[data-slot="max-side-help"]').textContent).toContain('ceiling');
        expect(playgroundCss).toContain('.urban-block-playground__piece.is-oversized { stroke: var(--cb-warning); stroke-dasharray: 6 3; }');
        expect(playgroundCss).toContain('.urban-block-playground__piece.is-acceptable { stroke: var(--cb-success); }');
    });

    it('keeps Propose disabled while the selected layout has no new streets', () => {
        const harness = createHarness();
        expect(harness.dialog.querySelector('[data-action="propose"]').disabled).toBe(true);
        planOneLayout(harness);
        expect(harness.dialog.querySelector('[data-action="propose"]').disabled).toBe(true);
    });
});
