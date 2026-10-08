// Focused model and DOM tests for public world activity filtering, labels, cycling, and scroll handoff.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { prepare, TYPES, locationOf, proposalTypeKey } = require('../../frontend/js/world/activity-model.js');
const activitySource = readFileSync(new URL('../../frontend/js/world/activity.js', import.meta.url), 'utf8');
const event = (id, type = 'create', occurredAt = '2026-10-01T12:00:00Z', extra = {}) => ({ id, source: 'live', ok: true, action: { type, proposalId: 'proposal-42' }, occurredAt, ...extra });

class FakeClassList {
    constructor(element) { this.element = element; this.values = new Set(); }
    add(...names) { names.forEach(name => this.values.add(name)); }
    remove(...names) { names.forEach(name => this.values.delete(name)); }
    contains(name) { return this.values.has(name); }
    toggle(name, force) {
        const add = force === undefined ? !this.values.has(name) : !!force;
        if (add) this.values.add(name); else this.values.delete(name);
        return add;
    }
}

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase(); this.children = []; this.parentElement = null;
        this.classList = new FakeClassList(this); this.attributes = new Map(); this.listeners = new Map();
        this.style = { setProperty: (key, value) => { this.style[key] = value; } };
        this.dataset = {}; this.hidden = false; this.tabIndex = this.tagName === 'A' ? 0 : -1;
        this.clientWidth = this.tagName === 'DIV' ? 120 : 0; this.clientHeight = this.tagName === 'DIV' ? 40 : 0;
        this.scrollWidth = 0; this.scrollLeft = 0; this.scrollTop = 0; this._text = '';
        this.pointerCaptureIds = [];
    }
    set className(value) { this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean)); }
    get className() { return [...this.classList.values].join(' '); }
    set textContent(value) { this.replaceChildren(); this._text = String(value ?? ''); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    append(...nodes) {
        for (const node of nodes) {
            if (node.parentElement) node.remove();
            if (this.classList.contains('world-activity__list') && node.tagName === 'LI' && node._rectWidth === undefined) node._rectWidth = [80, 140, 110][this.children.length % 3];
            node.parentElement = this; this.children.push(node);
        }
    }
    replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this._text = ''; this.append(...nodes); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    addEventListener(type, listener) { const entries = this.listeners.get(type) || []; entries.push(listener); this.listeners.set(type, entries); }
    removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener)); }
    setPointerCapture(pointerId) { this.pointerCaptureIds.push(pointerId); }
    dispatch(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener({ target: this, preventDefault() {}, ...event }); }
    matches(selector) { return selector === ':focus-visible' ? this.focusVisible === true : selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : selector.toUpperCase() === this.tagName; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
        const found = [];
        const visit = node => { for (const child of node.children) { if (child.matches(selector)) found.push(child); visit(child); } };
        visit(this); return found;
    }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    get firstElementChild() { return this.children[0] || null; }
    getBoundingClientRect() {
        if (this.classList.contains('world-activity__list')) return { width: this.children.reduce((sum, child) => sum + child._rectWidth, 0), height: this.children.length * 20 };
        if (this.tagName === 'LI') return { width: this._rectWidth || 100, height: 20 };
        return { width: 120, height: 40 };
    }
}

function mountActivity({ events, mobile = true, reducedMotion = false, transform = 'matrix(1, 0, 0, 1, 0, 0)', coverage = null }) {
    const root = new FakeElement('main');
    const mediaListeners = new Set();
    const media = { matches: mobile, addEventListener: (_type, listener) => mediaListeners.add(listener),
        removeEventListener: (_type, listener) => mediaListeners.delete(listener), change: () => mediaListeners.forEach(listener => listener()) };
    const window = {
        WorldActivityModel: require('../../frontend/js/world/activity-model.js'),
        WorldProposalEntry: { href: row => row.href, open: async () => {} },
        CityConfigManager: { getCityConfig: id => id === 'tbilisi' ? { label: 'Tbilisi' } : null, getCityCenter: () => [41.7, 44.8] },
        getBackendBase: () => 'https://api.example.test', matchMedia: () => media,
        getComputedStyle: () => ({ transform }),
        setInterval: () => 1, clearInterval: () => {},
        DOMMatrixReadOnly: class {
            constructor(value) {
                const values = value.match(/^matrix\(([^)]+)\)$/)?.[1].split(',').map(Number) || [];
                [this.a, this.b, this.c, this.d, this.m41, this.m42] = values;
            }
        }
    };
    const document = { hidden: false, activeElement: null, createElement: tagName => new FakeElement(tagName) };
    const fetch = async () => ({ ok: true, json: async () => ({ events }) });
    const context = vm.createContext({ window, document, fetch, AbortController, AbortSignal, DOMMatrixReadOnly: window.DOMMatrixReadOnly,
        Intl, Date, URLSearchParams, console: { warn() {} }, CbFormat: { formatDateTime: () => 'now' } });
    vm.runInContext(activitySource, context);
    const mounted = window.WorldActivity.mount(root, {
        t: (key, fallback) => key.startsWith('modal.roadWidth.proposalList.goalLabels.') ? `label:${key.split('.').at(-1)}` : (fallback || key),
        reducedMotion, coverage
    });
    return new Promise(resolve => setTimeout(() => resolve({ root, panel: root.firstElementChild, media, mounted }), 0));
}

const activityEvents = (count, extra = {}) => Array.from({ length: count }, (_, index) => event(`event-${index}`, 'create', `2026-10-0${index + 1}T12:00:00Z`, {
    cityId: 'tbilisi', proposalType: 'road-track', proposalPrimaryType: 'Road', ...extra
}));

describe('world recent activity', () => {
    it('shows only successful, linkable, dated public milestones', () => {
        const rows = [event('good'), event('fail', 'resolve', undefined, { ok: false }), event('sim', 'create', undefined, { source: 'simulation' }), event('noise', 'run_status'), event('bad-date', 'execute', 'garbage'), event('no-proposal', 'accept', undefined, { action: { type: 'accept' } })];
        expect(prepare(rows).map(e => e.id)).toEqual(['good']);
    });
    it('orders newest first, removes repeated IDs and caps the list', () => {
        const old = event('old'); const fresh = event('new', 'resolve', '2026-10-02T12:00:00Z');
        expect(prepare([old, fresh, fresh], 1).map(e => e.id)).toEqual(['new']);
        expect(prepare(Array.from({ length: 40 }, (_, i) => event(String(i))), 100)).toHaveLength(30);
        expect(prepare(null)).toEqual([]);
    });
    it('preserves the proposal and city scope without injected URL parameters', () => {
        const row = event('x', 'execute', undefined, { action: { type: 'execute', proposalId: 'abc&world=1' }, cityId: 'new_york', proposalName: '<script>title</script>' });
        const prepared = prepare([row])[0]; const url = new URL(prepared.href, 'https://example.com');
        expect(url.searchParams.get('focusProposal')).toBe('abc&world=1');
        expect(url.searchParams.get('city')).toBe('new_york');
        expect(url.searchParams.has('world')).toBe(false);
        expect(prepared.subject).toBe('<script>title</script>');
    });
    it('preserves durable proposal type separately from the activity action and never guesses it', () => {
        const row = event('x', 'create', undefined, { proposalType: 'park', proposalPrimaryType: 'Purchase' });
        expect(prepare([row])[0]).toMatchObject({ type: 'create', proposalType: 'park', proposalPrimaryType: 'Purchase' });
        expect(prepare([event('unknown-type', 'execute')])[0]).toMatchObject({ type: 'execute', proposalType: null, proposalPrimaryType: null });
    });
    it('selects a localized type key from durable goal and canonical primary type', () => {
        expect(proposalTypeKey({ proposalType: 'road-track', proposalPrimaryType: 'Track' })).toBe('track');
        expect(proposalTypeKey({ proposalType: 'urban_rule' })).toBe('urban-rule');
        expect(proposalTypeKey({ proposalType: 'parcelBased' })).toBe('parcelBased');
        expect(proposalTypeKey({ proposalPrimaryType: 'Road' })).toBe('road');
        expect(proposalTypeKey({ type: 'execute' })).toBe('other');
    });
    it('labels known cities precisely and distinguishes approximate countries and nearby cities', () => {
        const city = id => id === 'zagreb' ? { name: 'Zagreb', lat: 45.8, lon: 16 } : null;
        const coverage = { nameAt: () => ({ kind: 'country', name: 'Croatia', cc: 'HR' }) };
        expect(locationOf({ cityId: 'zagreb', location: { lat: 45.8, lon: 16 } }, { city, coverage })).toEqual({ kind: 'city', name: 'Zagreb' });
        expect(locationOf({ cityId: 'zagreb', location: { lat: 44, lon: 16 } }, { city, coverage })).toEqual({ kind: 'country', name: 'Croatia', cc: 'HR' });
        expect(locationOf({ cityId: 'explore', location: { lat: 45.8, lon: 16 } }, { city, coverage: { nameAt: () => ({ kind: 'city', name: 'Zagreb' }) } })).toMatchObject({ kind: 'near', name: 'Zagreb' });
        expect(locationOf({ cityId: 'explore', location: null }, { city, coverage })).toEqual({ kind: 'unknown', name: '' });
        expect(prepare([event('bad', 'create', undefined, { location: { lat: null, lon: 16 } })])[0].location).toBeNull();
    });
    it('links every supported milestone including execution and market resolution', () => {
        for (const type of TYPES) expect(prepare([event(type, type)])[0]).toMatchObject({ type, proposalId: 'proposal-42' });
        expect(prepare([event('entity', 'claim', undefined, { action: { type: 'claim' }, entity: { type: 'proposal', id: 'entity-1' } })])[0].href).toContain('entity-1');
    });
    it('shows compact city and proposal type, with one accessible link per event', async () => {
        const { panel, mounted } = await mountActivity({ events: activityEvents(2) });
        const links = panel.querySelectorAll('a');
        expect(panel.classList.contains('world-activity--cycling')).toBe(true);
        expect(links).toHaveLength(4);
        expect(links.slice(0, 2).map(link => link.querySelector('.world-activity__compact').textContent)).toEqual([
            'Tbilisilabel:road', 'Tbilisilabel:road'
        ]);
        expect(links.slice(2).every(link => link.tabIndex === -1 && link.parentElement.parentElement.getAttribute('aria-hidden') === 'true')).toBe(true);
        mounted.destroy();
    });
    it('shortens an urban-rule proposal to the zoning type in the compact row', async () => {
        const { panel, mounted } = await mountActivity({ events: activityEvents(1, { proposalType: 'urban-rule' }) });
        expect(panel.querySelector('.world-activity__compact-type').textContent).toBe('Zoning');
        mounted.destroy();
    });
    it('hands mobile cycling into horizontal scroll at the current offset and wheel advances it', async () => {
        const { panel, mounted } = await mountActivity({ events: activityEvents(3), transform: 'matrix(1, 0, 0, 1, -300, 0)' });
        const viewport = panel.querySelector('.world-activity__viewport');
        expect(panel.classList.contains('world-activity--cycling')).toBe(true);
        viewport.dispatch('wheel', { deltaX: 20, deltaY: 20, deltaMode: 0 });
        expect(panel.classList.contains('world-activity--cycling')).toBe(false);
        expect(panel.classList.contains('world-activity--manual')).toBe(true);
        expect(viewport.scrollLeft).toBe(100);
        expect(viewport.scrollTop).toBe(0);
        expect(panel.querySelectorAll('.world-activity__copy')).toHaveLength(0);
        mounted.destroy();
    });
    it('uses vertical manual handoff on desktop and turns cycling off for reduced motion', async () => {
        const desktop = await mountActivity({ events: activityEvents(4), mobile: false, transform: 'matrix(1, 0, 0, 1, 0, -50)' });
        const viewport = desktop.panel.querySelector('.world-activity__viewport');
        viewport.dispatch('wheel', { deltaY: 10, deltaMode: 0 });
        expect(viewport.scrollTop).toBe(40);
        expect(viewport.scrollLeft).toBe(0);
        desktop.mounted.destroy();

        const reduced = await mountActivity({ events: activityEvents(4), reducedMotion: true });
        expect(reduced.panel.classList.contains('world-activity--static')).toBe(true);
        expect(reduced.panel.classList.contains('world-activity--cycling')).toBe(false);
        expect(reduced.panel.querySelectorAll('.world-activity__copy')).toHaveLength(0);
        reduced.mounted.destroy();
    });
    it('rerenders at the mobile breakpoint and hands focus navigation to manual scrolling', async () => {
        const { panel, media, mounted } = await mountActivity({ events: activityEvents(2), mobile: false });
        expect(panel.classList.contains('world-activity--cycling')).toBe(false);
        media.matches = true;
        media.change();
        expect(panel.classList.contains('world-activity--cycling')).toBe(true);
        const firstLink = panel.querySelector('a');
        firstLink.focusVisible = true;
        panel.querySelector('.world-activity__viewport').dispatch('focusin', { target: firstLink });
        expect(panel.classList.contains('world-activity--manual')).toBe(true);
        expect(panel.querySelectorAll('.world-activity__copy')).toHaveLength(0);
        mounted.destroy();
    });
    it('uses the bare nearby city in compact mode and waits for a swipe before removing the clone', async () => {
        const { panel, mounted } = await mountActivity({
            events: activityEvents(2, { cityId: 'explore', location: { lat: 41.72, lon: 44.8 } }),
            coverage: { nameAt: () => ({ kind: 'city', name: 'Rustavi' }) }
        });
        const viewport = panel.querySelector('.world-activity__viewport');
        const links = panel.querySelectorAll('a');
        expect(links[0].querySelector('.world-activity__compact-city').textContent).toBe('Rustavi');
        const copyLink = links.at(-1);
        viewport.dispatch('pointerdown', { target: copyLink, pointerId: 7, clientX: 100, clientY: 10 });
        viewport.dispatch('pointerup', { target: copyLink, pointerId: 7, clientX: 100, clientY: 10 });
        expect(viewport.pointerCaptureIds).toEqual([]);
        expect(panel.querySelectorAll('.world-activity__copy')).toHaveLength(1);
        viewport.dispatch('pointerdown', { target: copyLink, pointerId: 7, clientX: 100, clientY: 10 });
        viewport.dispatch('pointermove', { target: copyLink, pointerId: 7, clientX: 80, clientY: 11 });
        expect(panel.querySelectorAll('.world-activity__copy')).toHaveLength(0);
        expect(panel.classList.contains('world-activity--manual')).toBe(true);
        mounted.destroy();
    });
});
