// Focused model and DOM tests for the public world activity (GET /activity/recent): agreements proposed,
// their outcomes and the bets and support on them, each linked by the agreement's CID; filtering, links,
// labels, cycling, and scroll handoff.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { cidOf } from '../cid.js';
const require = createRequire(import.meta.url);
const { prepare, TYPES, locationOf, goalKey } = require('../../frontend/js/world/activity-model.js');
const activitySource = readFileSync(new URL('../../frontend/js/world/activity.js', import.meta.url), 'utf8');
const activityRoute = readFileSync(new URL('../routes/agent-activity.js', import.meta.url), 'utf8');
const AGREEMENT = 'bafkreiftzbz2gpufkdckedn2fgb6jiq3qxd6zeohfzmgm42rysek3kuf7y';
const DESIGN = 'bafkreiehkrtqnkc7fjuviaz4oyqis7wexv3zsq3vfzknyf43rc5qvygce4';
const ACCOUNT = 'E323eSpdyobhdFKPCi2wcMj12ryFcJjhjKfZjpH8pxBh';
// One /activity/recent event as the route sends it: about an agreement, by its CID.
const event = (id, type = 'propose', occurredAt = '2026-10-01T12:00:00Z', extra = {}) => ({
    id, source: 'live', ok: true, action: { type, agreementCid: AGREEMENT }, entity: { type: 'agreement', id: AGREEMENT }, occurredAt, ...extra
});

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

function mountActivity({ events, mobile = true, reducedMotion = false, transform = 'matrix(1, 0, 0, 1, 0, 0)', coverage = null, entry = {} }) {
    const root = new FakeElement('main');
    const mediaListeners = new Set();
    const media = { matches: mobile, addEventListener: (_type, listener) => mediaListeners.add(listener),
        removeEventListener: (_type, listener) => mediaListeners.delete(listener), change: () => mediaListeners.forEach(listener => listener()) };
    const window = {
        WorldActivityModel: require('../../frontend/js/world/activity-model.js'),
        WorldProposalEntry: { href: row => row.href, open: async () => {}, openAgreement: async () => {}, openBet: async () => {}, ...entry },
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
        Intl, Date, URLSearchParams, console: { warn() {} }, CbFormat: { formatDateTime: () => 'now', formatMoney: (amount, code) => `${amount.toFixed(2)} ${code}` } });
    vm.runInContext(activitySource, context);
    const mounted = window.WorldActivity.mount(root, {
        t: (key, fallback, params = {}) => key.startsWith('modal.roadWidth.proposalList.goalLabels.') ? `label:${key.split('.').at(-1)}`
            : String(fallback || key).replace(/\{\{(\w+)\}\}/g, (_, name) => params[name] ?? ''),
        reducedMotion, coverage
    });
    return new Promise(resolve => setTimeout(() => resolve({ root, panel: root.firstElementChild, media, mounted }), 0));
}

const activityEvents = (count, extra = {}) => Array.from({ length: count }, (_, index) => event(`event-${index}`, 'propose', `2026-10-0${index + 1}T12:00:00Z`, {
    cityId: 'tbilisi', designGoal: 'road-track', ...extra
}));

describe('world recent activity', () => {
    it('shows only successful, linkable, dated public milestones about an agreement', () => {
        const rows = [event('good'), event('fail', 'resolve', undefined, { ok: false }), event('sim', 'propose', undefined, { source: 'simulation' }),
            event('noise', 'run_status'), event('bad-date', 'execute', 'garbage'),
            // a mint, a fund or a published design is explorer detail, not a landing milestone
            event('mint', 'mint'), event('design', 'design', undefined, { action: { type: 'design', designCid: DESIGN }, entity: { type: 'design', id: DESIGN } }),
            // no agreement, or something that is not an agreement CID, cannot be linked
            event('no-agreement', 'cancel', undefined, { action: { type: 'cancel' }, entity: null }),
            event('not-a-cid', 'execute', undefined, { action: { type: 'execute', agreementCid: 'proposal-42' }, entity: { type: 'agreement', id: 'proposal-42' } })];
        expect(prepare(rows).map(e => e.id)).toEqual(['good']);
    });
    it('shows what /activity/recent sends: the agreements proposed and the chain actions it keeps', () => {
        const recent = activityRoute.match(/const RECENT_CHAIN_ACTIONS = new Set\(\[([^\]]*)\]\);/);
        expect(recent).not.toBeNull();
        const chainActions = [...recent[1].matchAll(/'([A-Za-z]+)'/g)].map(match => match[1]);
        expect(chainActions).toEqual(expect.arrayContaining(['execute', 'expire', 'stake']));
        expect([...TYPES].sort()).toEqual(['propose', ...chainActions].sort());
    });
    it('orders newest first, removes repeated IDs and caps the list', () => {
        const old = event('old'); const fresh = event('new', 'resolve', '2026-10-02T12:00:00Z');
        expect(prepare([old, fresh, fresh], 1).map(e => e.id)).toEqual(['new']);
        expect(prepare(Array.from({ length: 40 }, (_, i) => event(String(i))), 100)).toHaveLength(30);
        expect(prepare(null)).toEqual([]);
    });
    it('links an agreement to its own page in its city without injected URL parameters', () => {
        const row = event('x', 'execute', undefined, { cityId: 'new_york&world=1', agreementName: '<script>title</script>' });
        const prepared = prepare([row])[0]; const url = new URL(prepared.href, 'https://example.com');
        expect(url.pathname).toBe(`/agreements/${AGREEMENT}`);
        expect(url.searchParams.get('city')).toBe('new_york&world=1');
        expect(url.searchParams.has('world')).toBe(false);
        expect(prepared).toMatchObject({ agreementCid: AGREEMENT, subject: '<script>title</script>' });
        // Without a name the subject is the agreement's short CID; without a city there is no query.
        expect(prepare([event('y', 'cancel')])[0]).toMatchObject({ subject: 'bafkreiftzbz…3kuf7y', href: `/agreements/${AGREEMENT}` });
        // An event whose entity is something else still links the agreement its action names.
        expect(prepare([event('z', 'donate', undefined, { entity: null })])[0].agreementCid).toBe(AGREEMENT);
    });
    it('keeps a multi-chunk UnixFS agreement CID linkable in world activity', () => {
        const bytes = new Uint8Array(256 * 1024 + 1);
        bytes.fill(0x62);
        const cid = cidOf(bytes);
        expect(cid).toMatch(/^bafybei[a-z2-7]{52}$/);
        const prepared = prepare([event('large-cid', 'execute', undefined, {
            action: { type: 'execute', agreementCid: cid }, entity: { type: 'agreement', id: cid }
        })]);
        expect(prepared).toHaveLength(1);
        expect(prepared[0]).toMatchObject({ agreementCid: cid, href: `/agreements/${cid}` });
    });
    it('keeps the design goal separately from the activity action and never guesses it', () => {
        expect(prepare([event('x', 'propose', undefined, { designGoal: ' park ' })])[0]).toMatchObject({ type: 'propose', designGoal: 'park' });
        expect(prepare([event('unknown-goal', 'execute', undefined, { designGoal: '  ' })])[0]).toMatchObject({ type: 'execute', designGoal: null });
        expect(prepare([event('no-goal', 'execute')])[0].designGoal).toBeNull();
    });
    it("selects a localized goal key from the first design's goal", () => {
        expect(goalKey({ designGoal: 'road-track' })).toBe('road-track');
        expect(goalKey({ designGoal: 'urban_rule' })).toBe('urban-rule');
        expect(goalKey({ designGoal: 'Parcel Layout' })).toBe('parcel-layout');
        expect(goalKey({ designGoal: 'parcelBased' })).toBe('parcelBased');
        expect(goalKey({ designGoal: ' ' })).toBe('other');
        expect(goalKey({ type: 'execute' })).toBe('other');
        expect(goalKey()).toBe('other');
    });
    it('labels known cities precisely and distinguishes approximate countries and nearby cities', () => {
        const city = id => id === 'zagreb' ? { name: 'Zagreb', lat: 45.8, lon: 16 } : null;
        const coverage = { nameAt: () => ({ kind: 'country', name: 'Croatia', cc: 'HR' }) };
        expect(locationOf({ cityId: 'zagreb', location: { lat: 45.8, lon: 16 } }, { city, coverage })).toEqual({ kind: 'city', name: 'Zagreb' });
        expect(locationOf({ cityId: 'zagreb', location: { lat: 44, lon: 16 } }, { city, coverage })).toEqual({ kind: 'country', name: 'Croatia', cc: 'HR' });
        expect(locationOf({ cityId: 'explore', location: { lat: 45.8, lon: 16 } }, { city, coverage: { nameAt: () => ({ kind: 'city', name: 'Zagreb' }) } })).toMatchObject({ kind: 'near', name: 'Zagreb' });
        expect(locationOf({ cityId: 'explore', location: null }, { city, coverage })).toEqual({ kind: 'unknown', name: '' });
        expect(prepare([event('bad', 'propose', undefined, { location: { lat: null, lon: 16 } })])[0].location).toBeNull();
        expect(prepare([event('good', 'propose', undefined, { location: { lat: 45.81, lon: 15.98 } })])[0].location).toEqual({ lat: 45.81, lon: 15.98 });
    });
    it('links every supported milestone, including execution, expiry and market resolution, to its agreement', () => {
        expect(TYPES).toEqual(expect.arrayContaining(['propose', 'execute', 'cancel', 'expire', 'resolve']));
        for (const type of TYPES) expect(prepare([event(type, type)])[0]).toMatchObject({ type, agreementCid: AGREEMENT, href: `/agreements/${AGREEMENT}` });
    });
    it('colours only the milestones it shows, the expiry with a colour of its own (world.css)', () => {
        const css = readFileSync(new URL('../../frontend/css/world.css', import.meta.url), 'utf8');
        const styled = [...css.matchAll(/\.world-activity__event\[data-event-type="([^"]+)"\]/g)].map(match => match[1]);
        // No rule for a type the feed never shows (a per-parcel accept went with designs' consent, M2).
        expect(styled.filter(type => !TYPES.includes(type))).toEqual([]);
        expect(styled).toEqual(expect.arrayContaining(['execute', 'cancel', 'expire']));
    });

    it('links a bet to the bet itself, with its side and amount, and keeps agreement links for the rest', () => {
        const [stake] = prepare([event('s', 'stake', undefined, { action: { type: 'stake', agreementCid: AGREEMENT, side: 'yes', amount: '0.25' }, agreementAccount: ACCOUNT, cityId: 'zagreb' })]);
        expect(stake).toMatchObject({ type: 'stake', agreementAccount: ACCOUNT, side: 'yes', amount: '0.25', href: `/bets/${ACCOUNT}?city=zagreb` });
        for (const type of ['createMarket', 'resolve', 'claim']) expect(prepare([event(type, type, undefined, { agreementAccount: ACCOUNT })])[0].href).toBe(`/bets/${ACCOUNT}`);
        // Every chain event carries its agreement's account; only a bet's own actions link the bet,
        // and a malformed account is not linked.
        expect(prepare([event('a', 'execute', undefined, { agreementAccount: ACCOUNT })])[0]).toMatchObject({ agreementAccount: null, href: `/agreements/${AGREEMENT}` });
        expect(prepare([event('d', 'donate', undefined, { agreementAccount: ACCOUNT })])[0]).toMatchObject({ agreementAccount: null, href: `/agreements/${AGREEMENT}` });
        expect(prepare([event('x', 'stake', undefined, { agreementAccount: '../../evil' })])[0]).toMatchObject({ agreementAccount: null, side: null, amount: null, href: `/agreements/${AGREEMENT}` });
    });
    it('words a bet with its amount and side, and opens the bet rather than the agreement', async () => {
        const events = [event('s', 'stake', '2026-10-02T12:00:00Z', { action: { type: 'stake', agreementCid: AGREEMENT, side: 'no', amount: '1' }, agreementAccount: ACCOUNT, cityId: 'tbilisi' }),
            event('p', 'propose', '2026-10-01T12:00:00Z', { cityId: 'tbilisi', designGoal: 'park' })];
        const opened = [];
        const { panel, mounted } = await mountActivity({ events, mobile: false, entry: {
            openBet: async row => opened.push(['bet', row.agreementAccount]), openAgreement: async row => opened.push(['agreement', row.agreementCid])
        } });
        const [bet, propose] = panel.querySelectorAll('a');
        expect(bet.dataset.eventType).toBe('stake');
        expect(bet.querySelector('.world-activity__action').textContent).toBe('Bet 1.00 USDC on no');
        expect(bet.querySelector('.world-activity__compact-type').textContent).toBe('Bet 1.00 USDC on no');
        expect(propose.querySelector('.world-activity__action').textContent).toBe('Agreement proposed');
        expect(propose.querySelector('.world-activity__compact-type').textContent).toBe('label:park');
        await bet.listeners.get('click')[0]({ button: 0, preventDefault() {} });
        await propose.listeners.get('click')[0]({ button: 0, preventDefault() {} });
        expect(opened).toEqual([['bet', ACCOUNT], ['agreement', AGREEMENT]]);
        mounted.destroy();
    });
    it('says so when an agreement could not open, and releases the busy state', async () => {
        const { panel, mounted } = await mountActivity({ events: activityEvents(1), mobile: false, entry: {
            openAgreement: async () => { throw new Error('offline'); }
        } });
        await panel.querySelector('a').listeners.get('click')[0]({ button: 0, preventDefault() {} });
        const status = panel.querySelector('.world-activity__status');
        expect(status.textContent).toBe('Could not open this agreement. Please try again.');
        expect(status.hidden).toBe(false);
        expect(panel.getAttribute('aria-busy')).toBeNull();
        mounted.destroy();
    });
    it("shows compact city and the first design's goal, with one accessible link per event", async () => {
        const { panel, mounted } = await mountActivity({ events: activityEvents(2) });
        const links = panel.querySelectorAll('a');
        expect(panel.classList.contains('world-activity--cycling')).toBe(true);
        expect(links).toHaveLength(4);
        expect(links.slice(0, 2).map(link => link.querySelector('.world-activity__compact').textContent)).toEqual([
            'Tbilisilabel:road-track', 'Tbilisilabel:road-track'
        ]);
        expect(links.slice(2).every(link => link.tabIndex === -1 && link.parentElement.parentElement.getAttribute('aria-hidden') === 'true')).toBe(true);
        mounted.destroy();
    });
    it('shortens an urban-rule design to the zoning type in the compact row', async () => {
        const { panel, mounted } = await mountActivity({ events: activityEvents(1, { designGoal: 'urban-rule' }) });
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
