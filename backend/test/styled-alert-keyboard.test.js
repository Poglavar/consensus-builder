// Exercises the real alert of the dialog helper (frontend/js/ui/dialogs.js, what window.showStyledAlert
// delegates to) with a small DOM and keyboard harness: the dialog is described for assistive
// technology, OK takes the focus, Tab cycles the link and OK in both directions even when the focus
// was stolen, Enter from outside answers it, Escape goes through the modal router, the focus returns
// to the opener, and no key reaches the page behind.
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
        constructor(tag) { this.tag = tag; this.nodeType = 1; this.children = []; this.attrs = {}; this.style = {}; this.events = {}; this.className = ''; this.hidden = false; this.disabled = false; }
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
        remove() { if (this.parentNode) this.parentNode.removeChild(this); }
        setAttribute(key, value) { this.attrs[key] = value; }
        getAttribute(key) { return this.attrs[key]; }
        addEventListener(type, fn) { this.events[type] = fn; }
        removeEventListener(type) { delete this.events[type]; }
        focus() { document.activeElement = this; }
        click() { if (this.events.click) this.events.click({ preventDefault() {} }); }
        getClientRects() { return [1]; }
        get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
        contains(target) { return this === target || this.children.some(child => child.contains?.(target)); }
        set innerHTML(value) { this.html = value; }
        get firstChild() { return this.children[0] || null; }
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
    document.createTextNode = text => ({ nodeType: 3, textContent: text, contains: () => false });
    const opener = document.body.appendChild(new Element('button')); opener.focus();
    const router = createRouter(document);
    const window = { document, ModalEscape: router, requestAnimationFrame: fn => frames.push(fn) };
    const code = readFileSync(new URL('../../frontend/js/ui/dialogs.js', import.meta.url), 'utf8');
    const context = vm.createContext({ window, document, setTimeout, Promise });
    vm.runInContext(code, context);
    const key = (value, shiftKey = false) => {
        const event = { key: value, shiftKey, defaultPrevented: false, immediateStopped: false,
            preventDefault: vi.fn(function () { event.defaultPrevented = true; }), stopPropagation: vi.fn(),
            stopImmediatePropagation: vi.fn(function () { event.immediateStopped = true; }) };
        for (const listener of listeners) { listener(event); if (event.immediateStopped) break; }
        return event;
    };
    return { document, opener, listeners, router, key, open: window.CbDialog.alert, frame: () => frames.splice(0).forEach(fn => fn()) };
}

describe('alert keyboard and focus', () => {
    it('describes the dialog, focuses OK and cycles the link and OK in both directions', async () => {
        const h = harness(); const listenersBefore = h.listeners.size; // the router's own
        const done = h.open('Source information\n{{txLink}}', { linkUrl: 'https://example.org/terms' });
        const overlay = h.document.body.children[1], dialog = overlay.children[0];
        const [link, ok] = dialog.querySelectorAll();
        expect(dialog.attrs.role).toBe('alertdialog');
        expect(dialog.attrs['aria-modal']).toBe('true');
        expect(dialog.attrs['aria-describedby']).toBe(dialog.children[0].id);
        expect(link.href).toBe('https://example.org/terms');
        expect(link.className).toContain('cb-link--external');
        h.frame(); expect(h.document.activeElement).toBe(ok);

        // Tab from inside the box is the dialog's own listener (focus trap); from outside, the
        // document listener brings the focus back in.
        dialog.events.keydown({ key: 'Tab', shiftKey: false, preventDefault: vi.fn() });
        expect(h.document.activeElement).toBe(link);
        dialog.events.keydown({ key: 'Tab', shiftKey: true, preventDefault: vi.fn() });
        expect(h.document.activeElement).toBe(ok);
        h.document.activeElement = h.opener;
        expect(h.key('Tab').defaultPrevented).toBe(true);
        expect(h.document.activeElement).toBe(link);
        h.document.activeElement = h.opener;
        expect(h.key('Tab', true).defaultPrevented).toBe(true);
        expect(h.document.activeElement).toBe(ok);

        // A key the page listens for (a drawing hotkey) stops at the dialog.
        const stray = h.key('f');
        expect(stray.stopPropagation).toHaveBeenCalled();
        expect(stray.immediateStopped).toBe(true);

        // Enter from outside the box answers it; the focus goes back to the opener.
        h.document.activeElement = h.opener;
        expect(h.key('Enter').defaultPrevented).toBe(true);
        await done;
        expect(h.document.body.children).toHaveLength(1);
        expect(h.document.activeElement).toBe(h.opener);
        expect(h.listeners.size).toBe(listenersBefore); // the dialog's own keyboard listener is gone
    });

    it('closes on Escape through the modal router and gives the focus back', async () => {
        const h = harness(); const done = h.open('Plain message');
        h.frame();
        expect(h.router.topmost()).toBeTruthy();
        h.router.topmost().dismiss();
        await done;
        expect(h.document.body.children).toHaveLength(1);
        expect(h.document.activeElement).toBe(h.opener);
        expect(h.router.topmost()).toBeNull();
    });
});
