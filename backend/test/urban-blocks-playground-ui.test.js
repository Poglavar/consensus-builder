// Headless tests for the playground's public dialog actions and share-link UI.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const playgroundSource = readFileSync(new URL('../../frontend/js/urban-blocks-playground.js', import.meta.url), 'utf8');
const playgroundCss = readFileSync(new URL('../../frontend/css/urban-blocks-playground.css', import.meta.url), 'utf8');

function descendants(node) {
    return node.children.flatMap(child => [child, ...descendants(child)]);
}

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
        if (selector === 'svg') return this.node(selector, 'svg');
        if (selector === '.urban-block-playground__body') return this.node(selector);
        if (selector === '.urban-block-playground__side') return this.node(selector, 'aside');
        if (selector === '.urban-block-playground__chart') return this.node(selector, 'section');
        const setting = selector.match(/^\[data-setting="([^"]+)"\]$/);
        if (setting) return this.settings[setting[1]];
        if (selector === '[data-slot="pieces"] [aria-pressed="true"]') return null;
        if (selector === '[data-slot="pieces"] [data-piece-id]') return null;
        if (selector === '[data-slot="pieces"]') return this.node(selector);
        if (selector === '[data-slot="target-area"]') return this.node(selector, 'p');
        if (selector === '[data-slot="metrics"]') return this.node(selector);
        if (selector === '[data-slot="legend"]') return this.node(selector);
        if (selector === '[data-action="share"]') return this.node(selector, 'button');
        if (selector === '[data-action="generate"]') return this.node(selector, 'button');
        if (selector === '[data-slot="layout-select"]') return this.node(selector, 'select');
        const output = selector.match(/^\[data-output="([^"]+)"\]$/);
        if (output) return this.node(selector, 'output');
        const slot = selector.match(/^\[data-slot="([^"]+)"\]$/);
        if (slot) return this.node(selector, slot[1] === 'share-link' ? 'label' : 'span');
        const action = selector.match(/^\[data-action="([^"]+)"\]$/);
        if (action) return this.node(selector, 'button');
        const id = selector.match(/^#([\w-]+)$/);
        if (id) return this.node(selector, id[1] === 'urban-block-playground-title' ? 'h2' : 'div');
        return this.node(selector);
    }
    querySelectorAll(selector) {
        if (selector === '[data-action="close"]') return [];
        if (selector === '[data-setting="targetAreaM2"], [data-setting="maxSideM"], [data-setting="perimeterStepM"]') return [this.settings.targetAreaM2, this.settings.maxSideM, this.settings.perimeterStepM];
        if (selector === '[data-visibility]') return this.visibility;
        if (selector === '[data-slot="pieces"] [data-piece-id]') return [];
        if (selector === '.urban-block-playground__piece') return [];
        return [];
    }
    node(selector, tagName = 'div') {
        if (!this.nodes.has(selector)) {
            const node = new FakeNode(tagName);
            const slot = selector.match(/^\[data-slot="([^"]+)"\]$/);
            const action = selector.match(/^\[data-action="([^"]+)"\]$/);
            if (slot) node.dataset.slot = slot[1];
            if (action) node.dataset.action = action[1];
            if (slot?.[1] === 'share-link') node.hidden = true;
            if (slot?.[1] === 'share-url') node.readOnly = /data-slot="share-url"[^>]*\breadonly\b/.test(this.markup);
            if (action?.[1] === 'share') node.disabled = /data-action="share"[^>]*\bdisabled\b/.test(this.markup);
            this.nodes.set(selector, node);
            if (slot?.[1] === 'share-url') this.node('[data-slot="share-link"]', 'label').append(node);
        }
        return this.nodes.get(selector);
    }
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function createHarness({ clipboard = { writeText: vi.fn(() => Promise.resolve()) }, build = vi.fn(() => 'https://example.test/shared-layout'), parcels = null, targetAreaM2, targetSideM = 75 } = {}) {
    const dialog = new FakeDialog();
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
    window.document.body.append = node => { if (node instanceof FakeDialog) node.nodes.set('__dialog__', node); };
    window.document.createElement = tag => new FakeNode(tag);
    window.document.createElementNS = (_namespace, tag) => new FakeNode(tag);
    window.__dialog = dialog;

    // buildDialog constructs the real dialog from its public open() path; the fake dialog supplies
    // only the selectors and DOM operations that this module uses.
    const originalCreateElement = window.document.createElement;
    window.document.createElement = tag => tag === 'dialog' ? dialog : originalCreateElement(tag);
    runInNewContext(playgroundSource, { window, console: { warn() {} }, URL, Intl, Date, Number, String, Array, Math, JSON });
    const block = { type: 'Feature', id: 'block-1', properties: {}, geometry: {
        type: 'Polygon', coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]]
    } };
    const roads = { type: 'FeatureCollection', features: [] };
    window.UrbanBlocksPlayground.open({ block, roads, parcels, targetAreaM2, targetSideM, shareBaseUrl: 'https://example.test/map?city=explore' });
    return { dialog, workers, historyCalls, build, clipboard, window };
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
    it('shares current settings and empty cuts before Generate, revealing the field before clipboard completion', async () => {
        const copy = deferred();
        const clipboard = { writeText: vi.fn(() => copy.promise) };
        const build = vi.fn(() => 'https://example.test/shared-layout');
        const harness = createHarness({ clipboard, build });
        const button = harness.dialog.querySelector('[data-action="share"]');

        expect(button.disabled).toBe(false);
        const pending = click(button);
        const link = harness.dialog.querySelector('[data-slot="share-link"]');
        const field = harness.dialog.querySelector('[data-slot="share-url"]');
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
        expect(link.hidden).toBe(false);
        expect(link.contains(field)).toBe(true);
        expect(field.value).toBe('https://example.test/shared-layout');
        expect(field.readOnly).toBe(true);
        expect(field.focused).toBe(true);
        expect(field.selected).toBe(true);
        expect(harness.dialog.querySelector('[data-output="targetAreaM2"]').textContent).toBe('5625 m²');
        expect(status.textContent).toContain('Link ready');
        expect(clipboard.writeText).toHaveBeenCalledWith(field.value);

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

    it('keeps the visible link after clipboard rejection or missing clipboard access', async () => {
        const rejected = createHarness({ clipboard: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) } });
        await click(rejected.dialog.querySelector('[data-action="share"]'));
        expect(rejected.dialog.querySelector('[data-slot="share-link"]').hidden).toBe(false);
        expect(rejected.dialog.querySelector('[data-slot="share-status"]').textContent).toContain('Copy the selected link above');

        const unavailable = createHarness({ clipboard: null });
        await click(unavailable.dialog.querySelector('[data-action="share"]'));
        expect(unavailable.dialog.querySelector('[data-slot="share-link"]').hidden).toBe(false);
        expect(unavailable.dialog.querySelector('[data-slot="share-status"]').textContent).toContain('Copy the selected link above');
    });

    it('clears the link on settings or alternative changes and ignores a late clipboard result', async () => {
        const copy = deferred();
        const harness = createHarness({ clipboard: { writeText: vi.fn(() => copy.promise) } });
        planOneLayout(harness, [
            { cuts: { type: 'FeatureCollection', features: [] }, pieces: { type: 'FeatureCollection', features: [] }, stats: {} },
            { cuts: { type: 'FeatureCollection', features: [] }, pieces: { type: 'FeatureCollection', features: [] }, stats: {} }
        ]);

        const pending = click(harness.dialog.querySelector('[data-action="share"]'));
        const link = harness.dialog.querySelector('[data-slot="share-link"]');
        const status = harness.dialog.querySelector('[data-slot="share-status"]');
        expect(link.hidden).toBe(false);
        harness.dialog.querySelector('[data-setting="perimeterStepM"]').value = '200';
        harness.dialog.querySelector('[data-setting="perimeterStepM"]').dispatch('input');
        expect(link.hidden).toBe(true);
        expect(harness.dialog.querySelector('[data-slot="share-url"]').value).toBe('');
        expect(status.textContent).toBe('');

        const alternative = harness.dialog.querySelector('[data-slot="layout-select"]');
        alternative.value = '1';
        alternative.dispatch('change', { target: alternative });
        expect(link.hidden).toBe(true);

        copy.resolve();
        await pending;
        expect(status.textContent).toBe('');
        expect(link.hidden).toBe(true);
    });
});

describe('urban block playground result overlays', () => {
    it('labels every piece, matches sidebar shades, and marks hard-limit status with its outline', () => {
        const harness = createHarness();
        const pieces = [
            { type: 'Feature', id: 'piece-a', properties: { areaM2: 1200, longestSideM: 42, acceptable: true, labelPoint: [0.0003, 0.0005] }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.0005, 0], [0.0005, 0.001], [0, 0.001], [0, 0]]] } },
            { type: 'Feature', id: 'piece-b', properties: { areaM2: 1500, longestSideM: 68, acceptable: false, labelPoint: [0.0008, 0.0005] }, geometry: { type: 'Polygon', coordinates: [[[0.0005, 0], [0.001, 0], [0.001, 0.001], [0.0005, 0.001], [0.0005, 0]]] } }
        ];
        planOneLayout(harness, [{ cuts: { type: 'FeatureCollection', features: [] }, pieces: { type: 'FeatureCollection', features: pieces }, stats: {} }]);

        const svgNodes = descendants(harness.dialog.querySelector('svg'));
        const shapes = svgNodes.filter(node => hasClass(node, 'urban-block-playground__piece'));
        const labels = svgNodes.filter(node => hasClass(node, 'urban-block-playground__piece-area'));
        expect(shapes).toHaveLength(2);
        expect(shapes.map(node => node.attributes.class)).toEqual(expect.arrayContaining([
            expect.stringContaining('palette-0 is-acceptable'), expect.stringContaining('palette-1 is-oversized')
        ]));
        expect(shapes[0].attributes['aria-label']).toContain('Block 1');
        expect(shapes[0].children[0].textContent).toContain('1200 m²');
        expect(labels.map(node => node.textContent)).toEqual(['1200 m²', '1500 m²']);
        expect(labels.every(node => node.attributes.x !== undefined && node.attributes.y !== undefined)).toBe(true);

        const rows = harness.dialog.querySelector('[data-slot="pieces"]').children;
        const chips = rows.flatMap(row => row.children).filter(node => hasClass(node, 'urban-block-playground__piece-chip'));
        expect(chips.map(node => node.className)).toEqual(['urban-block-playground__piece-chip palette-0', 'urban-block-playground__piece-chip palette-1']);
        expect(chips.map(node => node.attributes.style)).toEqual(shapes.map(node => node.attributes.style));
        expect(new Set(shapes.map(node => node.attributes.style)).size).toBe(2);
        expect(harness.dialog.querySelector('[data-slot="max-side-help"]').textContent).toContain('ceiling');
        expect(playgroundCss).toContain('.urban-block-playground__piece.is-oversized { stroke: var(--cb-warning); stroke-dasharray: 6 3; }');
        expect(playgroundCss).toContain('.urban-block-playground__piece.is-acceptable { stroke: var(--cb-success); }');
    });

    it('clips supplied cadastral parcel borders to the block and refreshes them while open', () => {
        const parcel = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.0005, 0], [0.0005, 0.001], [0, 0.001], [0, 0]]] } };
        const parcels = { type: 'FeatureCollection', features: [parcel] };
        const harness = createHarness({ parcels });

        let svgNodes = descendants(harness.dialog.querySelector('svg'));
        let clip = svgNodes.find(node => node.tagName === 'clipPath');
        let layer = svgNodes.find(node => hasClass(node, 'urban-block-playground__parcels'));
        expect(clip.attributes.id).toBe('urban-block-playground-block-clip');
        expect(clip.children[0].attributes['clip-rule']).toBe('evenodd');
        expect(layer.attributes['clip-path']).toBe('url(#urban-block-playground-block-clip)');
        expect(layer.attributes['pointer-events']).toBe('none');
        expect(layer.children.filter(node => hasClass(node, 'urban-block-playground__parcel-border'))).toHaveLength(1);

        harness.window.UrbanBlocksPlayground.updateParcels({ type: 'FeatureCollection', features: [] });
        svgNodes = descendants(harness.dialog.querySelector('svg'));
        layer = svgNodes.find(node => hasClass(node, 'urban-block-playground__parcels'));
        expect(layer.children).toHaveLength(0);
    });
});
