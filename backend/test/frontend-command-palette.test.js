// The command palette (frontend/js/ui/command-palette.js) over the command registry: every palette
// command is listed, grouped in registry order, filtered by the query; commands whose when() is
// false stay visible but unavailable, with the reason when the registry can tell.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const UiCommands = require('../../frontend/js/ui/commands.js');
const Palette = require('../../frontend/js/ui/command-palette.js');

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');
const en = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'i18n', 'en.json'), 'utf8'));
const tEn = key => key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), en) ?? key;

const fakeCtx = (unavailable = {}) => ({
    global: {},
    isControlAvailable: id => !(id in unavailable),
    controlUnavailableReason: id => unavailable[id] || null
});
const groupOrder = Palette.registryGroupOrder(UiCommands.listCommands());
const view = (query, ctx = fakeCtx()) => Palette.groupPaletteItems(UiCommands.rankCommands(query, ctx, tEn), groupOrder, { query });

function modalPaletteHarness() {
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.nodeType = 1; this.children = []; this.attributes = {};
            this.dataset = {}; this.style = {}; this.events = {}; this.inert = false; this.hidden = false;
            this.parentNode = null; this.className = ''; this._textContent = '';
            this.classList = {
                add: name => { this.className = `${this.className} ${name}`.trim(); },
                remove: name => { this.className = this.className.split(/\s+/).filter(value => value !== name).join(' '); },
                contains: name => this.className.split(/\s+/).includes(name)
            };
        }
        get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
        get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
        get textContent() { return this._textContent + this.children.map(child => child.textContent || '').join(''); }
        set textContent(value) { this._textContent = String(value); this.children = []; }
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
        setAttribute(name, value) { this.attributes[name] = String(value); }
        getAttribute(name) { return this.attributes[name] ?? null; }
        removeAttribute(name) { delete this.attributes[name]; }
        matches(selector) { return selector === '[aria-modal="true"]' && this.getAttribute('aria-modal') === 'true'; }
        contains(target) { return this === target || this.children.some(child => child.contains?.(target)); }
        querySelector(selector) {
            for (const child of this.children) {
                if (child.matches?.(selector)) return child;
                const nested = child.querySelector?.(selector);
                if (nested) return nested;
            }
            return null;
        }
        querySelectorAll(selector) {
            const matches = node => selector.includes('[role="option"]')
                ? node.getAttribute('role') === 'option' && node.dataset.index !== undefined
                : false;
            return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...(child.querySelectorAll?.(selector) || [])]);
        }
        addEventListener(type, listener) { this.events[type] = listener; }
        focus() {
            for (let node = this; node; node = node.parentElement) if (node.hidden || node.inert) return;
            document.activeElement = this;
        }
        scrollIntoView() {}
        getClientRects() {
            for (let node = this; node; node = node.parentElement) if (node.hidden || node.style.display === 'none') return [];
            return [1];
        }
        compareDocumentPosition(other) {
            if (this.parentElement !== other.parentElement) return 0;
            return this.parentElement.children.indexOf(this) < this.parentElement.children.indexOf(other) ? 4 : 2;
        }
    }

    const document = {
        activeElement: null,
        createElement: tag => new Element(tag),
        contains: element => document.body.contains(element),
        addEventListener() {},
        querySelectorAll: () => [],
        getElementById: id => id === mapControl.id ? mapControl : null
    };
    document.body = new Element('body');
    document.defaultView = null;
    const window = {
        document,
        navigator: { platform: 'Linux' },
        addEventListener() {},
        getComputedStyle: element => ({ display: element.hidden ? 'none' : (element.style.display || 'block'), visibility: 'visible', zIndex: element.style.zIndex || '0' }),
        SearchModel: { keyAction: key => key === 'Enter' ? { type: 'run', index: 0 } : null },
        MapShell: { closeSheets() {} }
    };
    document.defaultView = window;

    const opener = document.body.appendChild(new Element('button'));
    opener.focus();
    const mapContainer = document.body.appendChild(new Element('main'));
    const mapControl = mapContainer.appendChild(new Element('select'));
    mapControl.id = 'tile-source-select';
    const entry = { id: 'settings.baseMap', group: 'settings', icon: 'fas fa-map', kind: 'input', control: 'tile-source-select' };
    window.UiCommands = {
        listCommands: () => [entry],
        rankCommands: () => [{ entry, label: 'Base map', rank: 0, available: true }],
        actionLabel: label => label,
        createBrowserContext: () => ({}),
        runCommand(id) {
            expect(id).toBe(entry.id);
            // The map control must be released from modal isolation before the command focuses it.
            expect(mapContainer.inert).toBe(false);
            mapControl.focus();
        }
    };

    const context = vm.createContext({ window, document, console, setTimeout });
    vm.runInContext(fs.readFileSync(new URL('../../frontend/js/ui/modal-escape.js', import.meta.url), 'utf8'), context);
    vm.runInContext(fs.readFileSync(new URL('../../frontend/js/ui/dialogs.js', import.meta.url), 'utf8'), context);
    vm.runInContext(fs.readFileSync(new URL('../../frontend/js/ui/command-palette.js', import.meta.url), 'utf8'), context);
    const registrations = [], releases = [];
    const register = window.ModalEscape.register;
    window.ModalEscape.register = (element, dismiss, options) => {
        registrations.push(element);
        const release = register(element, dismiss, options);
        return () => { releases.push(element); release(); };
    };
    return { document, window, opener, mapContainer, mapControl, registrations, releases, palette: window.CommandPalette };
}

describe('command palette', () => {
    it('registers modal isolation only while open and releases it before running a command', () => {
        const h = modalPaletteHarness();
        h.palette.initialize();
        expect(h.mapContainer.inert).toBe(false);
        expect(h.registrations).toHaveLength(0);
        expect(h.window.ModalEscape.topmost()).toBeNull();

        h.palette.open();
        expect(h.mapContainer.inert).toBe(true);
        expect(h.registrations).toHaveLength(1);
        expect(h.window.ModalEscape.topmost()?.element.hidden).toBe(false);

        h.document.activeElement.events.keydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
        expect(h.document.activeElement).toBe(h.mapControl);
        expect(h.mapContainer.inert).toBe(false);
        expect(h.releases).toHaveLength(1);
        expect(h.window.ModalEscape.topmost()).toBeNull();

        h.palette.open();
        expect(h.mapContainer.inert).toBe(true);
        expect(h.registrations).toHaveLength(2);
        h.palette.close();
        expect(h.mapContainer.inert).toBe(false);
        expect(h.document.activeElement).toBe(h.mapControl);
        expect(h.releases).toHaveLength(2);
        expect(h.window.ModalEscape.topmost()).toBeNull();
    });

    it('lists every palette command when the query is empty, grouped in registry order', () => {
        const groups = view('');
        const paletteCount = UiCommands.listCommands().filter(entry => entry.surfaces.includes('palette')).length;
        expect(groups.flatMap(g => g.items)).toHaveLength(paletteCount);
        expect(groups.map(g => g.group)).toEqual(groupOrder.filter(group => groups.some(g => g.group === group)));
        expect(groups[0].group).toBe('layers');
    });

    it('reports the on/off state of checkbox-backed toggles only', () => {
        const boxes = { showParcelNumbers: { checked: true }, showOwnerCounts: { checked: false }, measureButton: {} };
        const byId = id => boxes[id] || null;
        expect(Palette.toggleStateOf(UiCommands.findCommand('layers.parcelIds'), byId)).toBe(true);
        expect(Palette.toggleStateOf(UiCommands.findCommand('layers.ownerCounts'), byId)).toBe(false);
        // A button command, a toggle whose control is not in the page, no lookup: no state.
        expect(Palette.toggleStateOf(UiCommands.findCommand('tools.measure'), byId)).toBeNull();
        expect(Palette.toggleStateOf(UiCommands.findCommand('layers.adParcels'), byId)).toBeNull();
        expect(Palette.toggleStateOf(UiCommands.findCommand('layers.parcelIds'), null)).toBeNull();
        // Every toggle in the registry names the checkbox it reflects.
        for (const entry of UiCommands.listCommands().filter(e => e.kind === 'toggle')) expect(entry.control, entry.id).toBeTruthy();
    });

    it('leaves out the command that opens the palette itself', () => {
        expect(view('').flatMap(g => g.items).map(i => i.entry.id)).not.toContain('settings.commandPalette');
        expect(UiCommands.findCommand('settings.commandPalette')).toBeNull();
    });

    it('filters by the query and puts the group with the best match first', () => {
        const groups = view('measure');
        expect(groups[0].group).toBe('measurement');
        expect(groups[0].items[0].entry.id).toBe('tools.measure');
        expect(groups.flatMap(g => g.items).every(i => /measure/i.test(i.label) || /measure/i.test(i.entry.id) || i.entry.group === 'measurement')).toBe(true);
    });

    it('keeps an unavailable command visible, after the available ones, with the reason', () => {
        const ctx = fakeCtx({ measureButton: 'disabledIn3D' });
        const measurement = view('measure', ctx).find(g => g.group === 'measurement').items;
        const measure = measurement.find(i => i.entry.id === 'tools.measure');
        expect(measure).toMatchObject({ available: false, reason: 'disabledIn3D' });
        expect(measurement[measurement.length - 1].entry.id).toBe('tools.measure');
        // The search box only offers what can run.
        expect(UiCommands.searchCommands('measure', ctx, tEn).map(e => e.id)).not.toContain('tools.measure');
    });

    it('has no reason for a command the registry cannot explain', () => {
        const ranked = UiCommands.rankCommands('', { global: {}, isControlAvailable: () => false }, tEn);
        const measure = ranked.find(i => i.entry.id === 'tools.measure');
        expect(measure).toMatchObject({ available: false, reason: null });
        const global = ranked.find(i => i.entry.id === 'proposals.list');
        expect(global.available).toBe(true);
    });

    it('does not let a group of only unavailable matches outrank an available one', () => {
        const ctx = fakeCtx({ measureButton: 'disabled', pinpointButton: 'disabled', clearMeasurementsButton: 'disabled' });
        const groups = Palette.groupPaletteItems([
            { entry: { group: 'measurement' }, label: 'Measure', rank: 0, available: false },
            { entry: { group: 'roads' }, label: 'Measure road', rank: 1, available: true }
        ], groupOrder, { query: 'measure' });
        expect(groups.map(g => g.group)).toEqual(['roads', 'measurement']);
        expect(ctx.controlUnavailableReason('measureButton')).toBe('disabled');
    });

    it('runs the search box and city commands through their new homes', () => {
        const calls = [];
        const ctx = {
            global: {
                MapSearch: { focus: () => calls.push('focus'), showCities: () => calls.push('cities') },
                CityConfigManager: { detectNearestCity: () => calls.push('detect') }
            }
        };
        UiCommands.runCommand('parcels.locate', ctx);
        UiCommands.runCommand('settings.city', ctx);
        UiCommands.runCommand('settings.detectCity', ctx);
        expect(calls).toEqual(['focus', 'cities', 'detect']);
        expect(() => UiCommands.runCommand('parcels.locate', { global: {} })).toThrow(/MapSearch\.focus/);
    });
});

describe('command search cost and action labels', () => {
    it('never checks control availability for a query with no command matches', () => {
        const isControlAvailable = vi.fn(() => true);
        expect(UiCommands.rankCommands('unmatched-unique-place-name', { global: {}, isControlAvailable }, tEn)).toEqual([]);
        expect(isControlAvailable).not.toHaveBeenCalled();
    });
    it('states what clicking an enabled or disabled layer will do', () => {
        expect(UiCommands.actionLabel('Parks', true, tEn)).toBe('Turn off · Parks');
        expect(UiCommands.actionLabel('Parks', false, tEn)).toBe('Turn on · Parks');
        expect(UiCommands.actionLabel('Measure', null, tEn)).toBe('Measure');
    });
});
