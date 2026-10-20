import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const loading = require('../../frontend/novogradnje/loading.js');

function documentFixture() {
    const document = {
        createElement(tag) {
            const attributes = new Map();
            const classes = new Set();
            const listeners = new Map();
            return {
                tagName: tag.toUpperCase(), ownerDocument: document,
                children: [], parentNode: null, textContent: '', className: '',
                classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
                setAttribute: (name, value) => attributes.set(name, String(value)),
                getAttribute: name => attributes.get(name),
                appendChild(child) { this.children.push(child); child.parentNode = this; },
                remove() {
                    if (this.parentNode) {
                        this.parentNode.children = this.parentNode.children.filter(child => child !== this);
                        this.parentNode = null;
                    }
                },
                addEventListener(name, handler) {
                    if (!listeners.has(name)) listeners.set(name, new Set());
                    listeners.get(name).add(handler);
                },
                removeEventListener: (name, handler) => listeners.get(name)?.delete(handler),
                dispatch(name) { for (const handler of [...listeners.get(name) || []]) handler(); },
                listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
            };
        },
    };
    return document;
}

describe('Novogradnje loading indicator', () => {
    it('preserves content and exposes a safe accessible label', () => {
        const document = documentFixture();
        const host = document.createElement('section');
        const content = document.createElement('p');
        host.appendChild(content);
        const label = '<img src=x onerror=alert(1)>';
        const stop = loading.start(host, label);
        expect(host.children[0]).toBe(content);
        const indicator = host.children[1];
        expect(indicator.className).toBe('loading-indicator');
        expect(indicator.getAttribute('role')).toBe('status');
        expect(indicator.getAttribute('aria-label')).toBe(label);
        expect(indicator.children[0].className).toBe('sr-only');
        expect(indicator.children[0].textContent).toBe(label);
        expect(indicator.children[0].children).toEqual([]);
        expect(host.getAttribute('aria-busy')).toBe('true');
        expect(host.classList.contains('is-loading')).toBe(true);
        stop();
        stop();
        expect(host.children).toEqual([content]);
        expect(host.getAttribute('aria-busy')).toBe('false');
        expect(host.classList.contains('is-loading')).toBe(false);
    });

    it('keeps overlapping requests busy through stale and repeated completion', () => {
        const host = documentFixture().createElement('section');
        const first = loading.start(host);
        const second = loading.start(host);
        expect(host.children[0].getAttribute('aria-label')).toBe('Učitavanje…');
        first();
        expect(host.children).toHaveLength(1);
        expect(host.getAttribute('aria-busy')).toBe('true');
        second();
        const third = loading.start(host);
        first();
        second();
        expect(host.children).toHaveLength(1);
        expect(host.classList.contains('is-loading')).toBe(true);
        third();
        expect(host.getAttribute('aria-busy')).toBe('false');
    });

    it.each(['load', 'error'])('settles media on %s and removes both listeners', event => {
        const document = documentFixture();
        const host = document.createElement('section');
        const image = document.createElement('img');
        image.complete = false;
        const cleanup = loading.media(host, image);
        expect(host.getAttribute('aria-busy')).toBe('true');
        expect(image.listenerCount()).toBe(2);
        image.dispatch(event);
        expect(host.children).toHaveLength(0);
        expect(host.getAttribute('aria-busy')).toBe('false');
        expect(image.listenerCount()).toBe(0);
        cleanup();
    });

    it.each([0, 200])('immediately settles a complete image with naturalWidth %s', naturalWidth => {
        const document = documentFixture();
        const host = document.createElement('section');
        const image = document.createElement('img');
        Object.assign(image, { complete: true, naturalWidth });
        loading.media(host, image);
        expect(host.children).toHaveLength(0);
        expect(host.getAttribute('aria-busy')).toBe('false');
        expect(image.listenerCount()).toBe(0);
    });

    it('cleans up detached media without clearing a newer request', () => {
        const document = documentFixture();
        const host = document.createElement('section');
        const frame = document.createElement('iframe');
        const cleanup = loading.media(host, frame, 'Učitavanje prikaza…');
        const stopNewer = loading.start(host);
        cleanup();
        cleanup();
        frame.dispatch('load');
        expect(frame.listenerCount()).toBe(0);
        expect(host.children).toHaveLength(1);
        expect(host.getAttribute('aria-busy')).toBe('true');
        stopNewer();
        expect(host.getAttribute('aria-busy')).toBe('false');
    });

    it('exposes the browser API and uses the global document when needed', () => {
        const document = documentFixture();
        const window = { document };
        vm.runInNewContext(readFileSync(new URL('../../frontend/novogradnje/loading.js', import.meta.url), 'utf8'), { window });
        const host = document.createElement('section');
        delete host.ownerDocument;
        const stop = window.NovogradnjeLoading.start(host);
        expect(host.children).toHaveLength(1);
        stop();
        expect(host.children).toHaveLength(0);
    });
});
