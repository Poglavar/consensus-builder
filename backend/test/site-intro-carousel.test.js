// Headless interaction coverage for the site introduction carousel.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../../frontend/js/site-intro.js', import.meta.url), 'utf8');

function makeNode(tag = 'div', attributes = {}) {
    const listeners = {};
    const node = {
        tag, attributes: { ...attributes }, listeners, children: [], hidden: false, disabled: false,
        textContent: '', className: '', parentNode: null,
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name] ?? null; },
        removeAttribute(name) { delete this.attributes[name]; },
        appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
        addEventListener(type, callback) { (listeners[type] ||= []).push(callback); },
        fire(type, event = {}) { for (const callback of listeners[type] || []) callback({ target: this, preventDefault() {}, ...event }); },
        focus() { this.ownerDocument.activeElement = this; },
        getClientRects() { return [{}]; },
        closest(selector) {
            for (let current = this; current; current = current.parentNode) {
                if (selector === '[data-site-intro-slide][hidden]' && current.attributes['data-site-intro-slide'] !== undefined && current.hidden) return current;
            }
            return null;
        },
        querySelectorAll(selector) {
            const matches = child => selector.startsWith('[data-')
                ? Object.hasOwn(child.attributes, selector.slice(1, -1))
                : selector.startsWith('.') ? child.className.split(/\s+/).includes(selector.slice(1)) : false;
            return this.children.flatMap(child => [
                ...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)
            ]);
        },
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    };
    node.classList = {
        add(name) { if (!node.classList.contains(name)) node.className = `${node.className} ${name}`.trim(); },
        remove(name) { node.className = node.className.split(/\s+/).filter(item => item && item !== name).join(' '); },
        contains(name) { return node.className.split(/\s+/).includes(name); }
    };
    return node;
}

function boot({ seen = null, search = '?intro=1', pathname = '/', hash = '', ownsBoot = false, storageUnavailable = false } = {}) {
    const windowListeners = {};
    const document = {
        readyState: 'complete', activeElement: null,
        addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }, listeners: {},
        body: makeNode('body'),
        querySelectorAll(selector) { return this.body.querySelectorAll(selector); },
        getElementById(id) { return id === 'site-intro-modal' ? modal : null; }
    };
    const modal = makeNode('div');
    modal.ownerDocument = document;
    modal.hidden = true;
    const card = makeNode('section'); card.className = 'site-intro-card';
    const slideArea = makeNode('div'); slideArea.className = 'site-intro-slides';
    const slides = ['explore', 'propose', 'consent', 'activity', 'sources'].map(key => {
        const slide = makeNode('article', { 'data-site-intro-slide': key });
        slide.ownerDocument = document;
        slide.hidden = key !== 'explore';
        return slide;
    });
    slides.forEach(slide => slideArea.appendChild(slide));
    const close = makeNode('button', { 'data-site-intro-close': '' });
    const skip = makeNode('button', { 'data-site-intro-close': '' });
    const back = makeNode('button', { 'data-site-intro-back': '' });
    const next = makeNode('button', { 'data-site-intro-next': '' });
    const progress = makeNode('span', { 'data-site-intro-progress': '' });
    const dots = slides.map((_, index) => makeNode('button', { 'data-site-intro-page': String(index) }));
    [card, slideArea, close, skip, back, next, progress, ...dots].forEach(node => {
        node.ownerDocument = document;
        modal.appendChild(node);
    });
    document.body.appendChild(modal);
    const reopen = makeNode('button', { 'data-site-intro-open': '' });
    reopen.ownerDocument = document;
    document.body.appendChild(reopen);
    const storage = new Map(seen === null ? [] : [['cb_site_intro_seen_v1', seen]]);
    const closedEvents = [];
    const window = {
        document, location: { search, pathname, hash }, localStorage: {
            getItem(key) { return storage.get(key) ?? null; },
            setItem(key, value) { storage.set(key, value); }
        },
        WorldEntry: { ownsBoot: () => ownsBoot },
        addEventListener(type, callback) { (windowListeners[type] ||= []).push(callback); },
        dispatchEvent(event) { closedEvents.push(event.type); for (const callback of windowListeners[event.type] || []) callback(event); }
    };
    if (storageUnavailable) Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
    class CustomEvent { constructor(type) { this.type = type; } }
    vm.runInNewContext(source, { window, document, CustomEvent, URLSearchParams, module: { exports: {} } });
    return { window, document, modal, slides, slideArea, close, skip, back, next, progress, dots, reopen, storage, closedEvents };
}

function pageIndex(slides) { return slides.findIndex(slide => !slide.hidden); }

describe('site intro carousel', () => {
    it.each([
        { pathname: '/', search: '' },
        { pathname: '/', search: '?city=nairobi' },
        { pathname: '/proposals/851', search: '?city=nairobi' },
        { pathname: '/proposals/12,13', search: '' },
        { pathname: '/proposals/garden-plan', search: '' },
        { pathname: '/plans/garden-plan/score', search: '' },
        { pathname: '/parcel/HR-335240-1323/2', search: '' },
        { pathname: '/bets/market-account', search: '' },
        { pathname: '/monitors/4', search: '' },
        { pathname: '/', search: '?parcel=HR-1' },
        { pathname: '/', search: '?design=851&photo=1' },
        { pathname: '/', search: '?activity=proposal%3A851' },
        { pathname: '/', search: '?scene=courtyard' },
        { pathname: '/', search: '?at=-1.264,36.840,17' },
        { pathname: '/', search: '', hash: '#selected-place' }
    ])('leaves a fresh arrival at $pathname$search$hash uninterrupted', location => {
        const app = boot({ ...location, storageUnavailable: true });
        expect(app.modal.hidden).toBe(true);
        expect(app.document.activeElement).toBeNull();
        expect(app.document.body.classList.contains('site-intro-open')).toBe(false);
        app.window.dispatchEvent({ type: 'worldview:landed' });
        expect(app.modal.hidden).toBe(true);
        expect(app.window.location).toMatchObject(location);
    });

    it('does not queue an automatic tour after a first-visit globe', () => {
        const app = boot({ search: '', ownsBoot: true });
        app.window.dispatchEvent({ type: 'worldview:landed' });
        expect(app.modal.hidden).toBe(true);
        app.reopen.fire('click');
        expect(app.modal.hidden).toBe(false);
    });

    it('retains a shared destination while an explicitly opened tour is viewed and closed', () => {
        const location = { pathname: '/proposals/851', search: '?city=nairobi&intro=1&at=-1.264,36.840,17', hash: '#details' };
        const app = boot(location);
        expect(app.modal.hidden).toBe(false);
        app.next.fire('click');
        app.skip.fire('click');
        expect(app.modal.hidden).toBe(true);
        expect(app.window.location).toEqual(location);
        expect(app.storage.size).toBe(0);
    });

    it('clamps page movement and recognizes horizontal swipes only', () => {
        const api = requireIntroApi();
        expect([api.introPageIndex(0, -1, 5), api.introPageIndex(4, 1, 5), api.introPageIndex(2, -1, 5)])
            .toEqual([0, 4, 1]);
        expect(api.introSwipeDelta({ x: 160, y: 20 }, { x: 90, y: 25 })).toBe(1);
        expect(api.introSwipeDelta({ x: 90, y: 25 }, { x: 160, y: 20 })).toBe(-1);
        expect(api.introSwipeDelta({ x: 100, y: 0 }, { x: 60, y: 0 })).toBe(0);
        expect(api.introSwipeDelta({ x: 100, y: 0 }, { x: 180, y: 90 })).toBe(0);
        expect(api.introSwipeDelta(null, { x: 0, y: 0 })).toBe(0);
        expect(api.introSwipeDelta({ x: NaN, y: 0 }, { x: 0, y: 0 })).toBe(0);
    });

    it('navigates with buttons, dots and keyboard, then closes once on the final CTA', () => {
        const app = boot();
        expect(pageIndex(app.slides)).toBe(0);
        expect(app.back.disabled).toBe(true);
        app.document.listeners.keydown[0]({ key: 'ArrowRight', preventDefault() {} });
        expect(pageIndex(app.slides)).toBe(1);
        app.document.listeners.keydown[0]({ key: 'ArrowLeft', preventDefault() {} });
        expect(pageIndex(app.slides)).toBe(0);
        app.next.fire('click');
        expect(pageIndex(app.slides)).toBe(1);
        app.back.fire('click');
        expect(pageIndex(app.slides)).toBe(0);
        app.dots[3].fire('click');
        expect(pageIndex(app.slides)).toBe(3);
        app.document.listeners.keydown[0]({ key: 'End', preventDefault() {} });
        expect(pageIndex(app.slides)).toBe(4);
        expect(app.next.getAttribute('data-i18n-key')).toBe('modal.siteIntro.cta');
        app.document.listeners.keydown[0]({ key: 'Home', preventDefault() {} });
        expect(pageIndex(app.slides)).toBe(0);
        app.document.listeners.keydown[0]({ key: 'ArrowLeft', preventDefault() {} });
        expect(pageIndex(app.slides)).toBe(0);
        app.document.listeners.keydown[0]({ key: 'End', preventDefault() {} });
        app.next.fire('click');
        app.next.fire('click');
        expect(app.modal.hidden).toBe(true);
        expect(app.closedEvents).toEqual(['siteintro:closed']);
        expect(app.storage.size).toBe(0);
    });

    it('skip closes from any slide and manual reopen resets to the first slide', () => {
        const app = boot({ seen: '1', search: '' });
        expect(app.modal.hidden).toBe(true);
        app.reopen.fire('click');
        expect(app.modal.hidden).toBe(false);
        expect(pageIndex(app.slides)).toBe(0);
        app.dots[2].fire('click');
        app.skip.fire('click');
        expect(app.modal.hidden).toBe(true);
        app.reopen.fire('click');
        expect(pageIndex(app.slides)).toBe(0);
        app.slideArea.fire('touchstart', { touches: [{ clientX: 200, clientY: 20 }, { clientX: 210, clientY: 20 }] });
        app.slideArea.fire('touchend', { touches: [], changedTouches: [{ clientX: 100, clientY: 20 }] });
        expect(pageIndex(app.slides)).toBe(0);
        expect(app.storage.get('cb_site_intro_seen_v1')).toBe('1');
    });
});

function requireIntroApi() {
    return require('../../frontend/js/site-intro.js');
}
