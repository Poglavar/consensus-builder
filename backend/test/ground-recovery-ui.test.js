// Verify recovery waits for the real intro close event and keeps its failure when reopened.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function boot() {
    const events = new EventTarget();
    const documentEvents = new EventTarget();
    const byId = new Map();
    const document = {
        readyState: 'loading',
        activeElement: null,
        addEventListener: documentEvents.addEventListener.bind(documentEvents),
        removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
        getElementById: id => byId.get(id) || null
    };
    const matches = (node, selector) => selector.startsWith('[data-')
        ? Object.hasOwn(node.attributes, selector.slice(1, -1))
        : selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1))
            : selector.startsWith('button') ? node.tag === 'button' && !node.disabled : node.tag === selector;
    document.createElement = tag => {
        const children = [], attributes = {}, listeners = {};
        const node = {
            tag, children, attributes, listeners, dataset: {}, className: '', hidden: false,
            textContent: '', parentNode: null,
            set id(id) { this._id = id; byId.set(id, this); }, get id() { return this._id; },
            setAttribute: (name, value) => { attributes[name] = value; },
            appendChild(child) { children.push(child); child.parentNode = node; return child; },
            append(...nodes) { nodes.forEach(child => node.appendChild(child)); },
            removeChild(child) { children.splice(children.indexOf(child), 1); child.parentNode = null; },
            replaceChildren(...nodes) { children.splice(0); nodes.forEach(child => node.appendChild(child)); },
            querySelectorAll(selector) { return children.flatMap(child => [
                ...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)
            ]); },
            querySelector(selector) { return node.querySelectorAll(selector)[0] || null; },
            addEventListener(type, callback) { listeners[type] = callback; },
            remove() { node.parentNode?.removeChild(node); if (node.id) byId.delete(node.id); },
            focus() { document.activeElement = node; },
            getClientRects: () => [{}]
        };
        node.classList = {
            add(name) { node.className = [...new Set([...node.className.split(' '), name])].join(' '); },
            remove(name) { node.className = node.className.split(' ').filter(item => item !== name).join(' '); },
            contains: name => node.className.split(' ').includes(name)
        };
        return node;
    };
    document.body = document.createElement('body');
    document.querySelectorAll = selector => document.body.querySelectorAll(selector);
    const intro = document.createElement('div');
    intro.id = 'site-intro-modal'; intro.hidden = true;
    const closeIntro = document.createElement('button');
    closeIntro.setAttribute('data-site-intro-close', '');
    intro.appendChild(closeIntro); document.body.appendChild(intro);
    const storage = new Map();
    const window = {
        document, location: { search: '?intro=1' },
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        CityConfigManager: {
            getCurrentCityId: () => 'sample',
            getAvailableCities: () => [{ id: 'sample', parcels: { source: 'parcel-source' } }]
        },
        addEventListener: events.addEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events)
    };
    const context = vm.createContext({ window, document, CustomEvent, URLSearchParams,
        requestAnimationFrame: callback => callback() });
    for (const path of ['site-intro.js', 'parcels/ground-fallback.js']) {
        vm.runInContext(readFileSync(new URL(`../../frontend/js/${path}`, import.meta.url), 'utf8'), context);
    }
    window.SiteIntro.initSiteIntro();
    return { window, document, intro };
}

describe('one parcel recovery dialog after the introduction', () => {
    it('waits without stealing intro focus, then opens when the intro is closed', () => {
        const { window, document, intro } = boot();
        const focus = document.activeElement;
        const failure = { city: 'sample', error: Object.assign(new Error('Gateway unavailable'), { status: 502 }),
            message: 'This source is unavailable. No parcels are loaded yet.' };
        expect(window.ParcelGroundFallback.onGroundUnavailable(failure)).toBe(true);
        expect(intro.hidden).toBe(false);
        expect(window.ParcelGroundFallback.isOpen()).toBe(false);
        expect(document.body.querySelectorAll('.ground-fallback-dialog')).toHaveLength(0);
        expect(document.activeElement).toBe(focus);
        window.closeSiteIntro();
        expect(window.ParcelGroundFallback.isOpen()).toBe(true);
        expect(document.body.querySelectorAll('.ground-fallback-dialog')).toHaveLength(1);
        expect(document.body.querySelector('.ground-fallback-status').textContent).toBe(failure.message);
        expect(document.body.classList.contains('ground-fallback-open')).toBe(true);
        window.ParcelGroundFallback.onGroundUnavailable(failure);
        expect(document.body.querySelectorAll('.ground-fallback-dialog')).toHaveLength(1);
    });

    it('reopens the same failure with the same wider options after dismissal', () => {
        const { window, document } = boot();
        window.closeSiteIntro();
        const error = Object.assign(new Error('Provider denied access'), { status: 502, upstreamStatus: 403 });
        window.ParcelGroundFallback.onGroundUnavailable({ city: 'sample', error, message: 'Provider denied access.' });
        const choices = () => document.body.querySelectorAll('button').filter(node => node.dataset.option).map(node => node.dataset.option);
        expect(choices()).toEqual(['url', 'ocr', 'schelling']);
        document.body.querySelector('.ground-fallback-close').listeners.click();
        expect(window.ParcelGroundFallback.isOpen()).toBe(false);
        expect(document.body.classList.contains('ground-fallback-open')).toBe(false);
        window.ParcelGroundFallback.openOptions();
        expect(document.body.querySelector('.ground-fallback-status').textContent).toBe('Provider denied access.');
        expect(choices()).toEqual(['url', 'ocr', 'schelling']);
    });
});
