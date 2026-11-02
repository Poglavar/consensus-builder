// Exercises the real alert of the dialog helper (frontend/js/ui/dialogs.js, what window.showStyledAlert
// delegates to) with a small DOM and keyboard harness: the dialog is described for assistive
// technology, OK takes the focus, Tab cycles the link and OK in both directions even when the focus
// was stolen, Enter from outside answers it, Escape goes through the modal router, the focus returns
// to the opener, and no key reaches the page behind.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function harness() {
    const listeners = new Set(), frames = [];
    const document = { activeElement: null,
        addEventListener: vi.fn((type, fn, capture) => { if (type === 'keydown' && capture) listeners.add(fn); }),
        removeEventListener: vi.fn((_type, fn) => listeners.delete(fn)) };
    class Element {
        constructor(tag) { this.tag = tag; this.tagName = tag.toUpperCase(); this.nodeType = 1; this.children = []; this.attrs = {}; this.style = {}; this.events = {}; this.className = ''; this.hidden = false; this.disabled = false; }
        get id() { return this.attrs.id || ''; }
        set id(value) { if (value) this.attrs.id = String(value); else delete this.attrs.id; }
        get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
        remove() { if (this.parentNode) this.parentNode.removeChild(this); }
        setAttribute(key, value) { this.attrs[key] = value; }
        getAttribute(key) { return this.attrs[key]; }
        matches(selector) { return selector === '[aria-modal="true"]' && this.attrs['aria-modal'] === 'true'; }
        addEventListener(type, fn) { this.events[type] = fn; }
        removeEventListener(type) { delete this.events[type]; }
        focus() { document.activeElement = this; }
        click() { if (this.events.click) this.events.click({ preventDefault() {} }); }
        getClientRects() { return [1]; }
        get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
        contains(target) { return this === target || this.children.some(child => child.contains?.(target)); }
        set innerHTML(value) { this.html = value; }
        get firstChild() { return this.children[0] || null; }
        querySelector(selector) {
            for (const child of this.children) {
                if (child.matches?.(selector)) return child;
                const nested = child.querySelector?.(selector);
                if (nested) return nested;
            }
            return null;
        }
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
    const window = { document, getComputedStyle: document.defaultView.getComputedStyle, requestAnimationFrame: fn => frames.push(fn) };
    const context = vm.createContext({ window, document, setTimeout, Promise });
    const modalEscape = readFileSync(new URL('../../frontend/js/ui/modal-escape.js', import.meta.url), 'utf8');
    const dialogs = readFileSync(new URL('../../frontend/js/ui/dialogs.js', import.meta.url), 'utf8');
    vm.runInContext(modalEscape, context);
    const router = window.ModalEscape;
    vm.runInContext(dialogs, context);
    const keyboardEvent = (value, shiftKey = false) => {
        const event = { key: value, shiftKey, defaultPrevented: false, immediateStopped: false,
            preventDefault: vi.fn(function () { event.defaultPrevented = true; }), stopPropagation: vi.fn(),
            stopImmediatePropagation: vi.fn(function () { event.immediateStopped = true; }) };
        return event;
    };
    const key = (value, shiftKey = false) => {
        const event = keyboardEvent(value, shiftKey);
        for (const listener of listeners) { listener(event); if (event.immediateStopped) break; }
        return event;
    };
    return { document, opener, listeners, router, key, keyboardEvent, open: window.CbDialog.alert, frame: () => frames.splice(0).forEach(fn => fn()) };
}

describe('alert keyboard and focus', () => {
    it('labels the dialog, focuses OK and cycles the link and OK in both directions', async () => {
        const h = harness(); const listenersBefore = h.listeners.size; // the router's own
        const done = h.open('Source information\n{{txLink}}', { linkUrl: 'https://example.org/terms' });
        const overlay = h.document.body.children[1], dialog = overlay.children[0];
        const [link, ok] = dialog.querySelectorAll();
        expect(dialog.attrs.role).toBe('alertdialog');
        expect(dialog.attrs['aria-modal']).toBe('true');
        expect(dialog.attrs['aria-labelledby']).toBe(dialog.children[0].id);
        expect(link.href).toBe('https://example.org/terms');
        expect(link.className).toContain('cb-link--external');
        h.frame(); expect(h.document.activeElement).toBe(ok);

        // Tab from inside the box is the dialog's own listener (focus trap); from outside, the
        // document listener brings the focus back in.
        dialog.events.keydown(h.keyboardEvent('Tab'));
        expect(h.document.activeElement).toBe(link);
        dialog.events.keydown(h.keyboardEvent('Tab', true));
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
