// Exercises the actual styled-alert implementation with a small DOM and keyboard event harness.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createRouter } = require('../../frontend/js/ui/modal-escape.js');

function harness() {
    const listeners = new Set(), frames = [];
    const document = { activeElement: null,
        addEventListener: vi.fn((type, fn, capture) => { if (type === 'keydown' && capture) listeners.add(fn); }),
        removeEventListener: vi.fn((_type, fn) => listeners.delete(fn)) };
    class Element {
        constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.style = {}; this.events = {}; }
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
        setAttribute(key, value) { this.attrs[key] = value; }
        addEventListener(type, fn) { this.events[type] = fn; }
        focus() { document.activeElement = this; }
        get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
        contains(target) { return this === target || this.children.some(child => child.contains?.(target)); }
        querySelectorAll() {
            return this.children.flatMap(child => [
                ...(child.tag === 'button' || (child.tag === 'a' && child.href) ? [child] : []),
                ...(child.querySelectorAll?.() || [])
            ]);
        }
    }
    document.body = new Element('body');
    document.defaultView = { getComputedStyle: element => ({ display: element.style.display || 'block', visibility: element.style.visibility || 'visible', zIndex: element.style.zIndex || '0' }) };
    document.createElement = tag => new Element(tag);
    document.createTextNode = text => ({ textContent: text });
    const opener = document.body.appendChild(new Element('button')); opener.focus();
    const code = readFileSync(new URL('../../frontend/js/city-config.js', import.meta.url), 'utf8');
    const source = code.slice(code.indexOf('    function showStyledAlert('), code.indexOf('    window.showStyledAlert = showStyledAlert;'));
    const router = createRouter(document);
    const context = vm.createContext({ document, window: { ModalEscape: router }, requestAnimationFrame: fn => frames.push(fn),
        renderMessageLines: (target, message) => { target.textContent = message; } });
    vm.runInContext(source, context);
    const key = (value, shiftKey = false) => {
        const event = { key: value, shiftKey, defaultPrevented: false, immediateStopped: false,
            preventDefault: vi.fn(function () { event.defaultPrevented = true; }), stopPropagation: vi.fn(),
            stopImmediatePropagation: vi.fn(function () { event.immediateStopped = true; }) };
        for (const listener of listeners) { listener(event); if (event.immediateStopped) break; }
        return event;
    };
    return { document, opener, listeners, router, key, open: context.showStyledAlert, frame: () => frames.splice(0).forEach(fn => fn()) };
}

describe('styled alert keyboard and focus', () => {
    it('describes the dialog, focuses OK and cycles source links in both directions', async () => {
        const h = harness(); const done = h.open('Source information\n{{txLink}}', { linkUrl: 'https://example.org/terms' });
        const overlay = h.document.body.children[1], dialog = overlay.children[0];
        const [link, ok] = dialog.querySelectorAll();
        expect(dialog.attrs.role).toBe('alertdialog');
        expect(dialog.attrs['aria-modal']).toBe('true');
        expect(dialog.attrs['aria-describedby']).toBe(dialog.children[0].id);
        h.frame(); expect(h.document.activeElement).toBe(ok);
        const tab = h.key('Tab'); expect(tab.preventDefault).toHaveBeenCalled();
        expect(h.document.activeElement).toBe(link);
        h.key('Tab', true); expect(h.document.activeElement).toBe(ok);
        h.key('Tab', true); expect(h.document.activeElement).toBe(link);
        h.key('Escape'); await done;
        expect(h.document.activeElement).toBe(h.opener);
        expect(h.router.size()).toBe(0);
        expect(overlay.parentNode).toBeNull();
    });
    it('captures map shortcuts and restores focus on OK without leaving a listener', async () => {
        const h = harness(); const done = h.open('Information'); h.frame();
        const event = h.key('f');
        expect(event.stopImmediatePropagation).toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
        h.document.activeElement.events.click(); await done;
        expect(h.document.activeElement).toBe(h.opener);
        expect(h.router.size()).toBe(0);
    });
    it('closes from backdrop and prevents delayed focus after closing', async () => {
        const h = harness(); const done = h.open('Information');
        const overlay = h.document.body.children[1]; overlay.events.click({ target: overlay });
        await done; h.frame(); expect(h.document.activeElement).toBe(h.opener);
        expect(h.document.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    });
    it('uses unique descriptions and recovers keyboard focus moved outside the dialog', async () => {
        const h = harness(); const first = h.open('First'); const id = h.document.body.children[1].children[0].children[0].id;
        h.key('Escape'); await first;
        const second = h.open('Second'); const dialog = h.document.body.children[1].children[0];
        expect(dialog.children[0].id).not.toBe(id);
        h.opener.focus(); h.key('Tab'); expect(h.document.activeElement).toBe(dialog.querySelectorAll()[0]);
        h.opener.focus(); h.key('Enter'); await second; expect(h.router.size()).toBe(0);
    });
});
