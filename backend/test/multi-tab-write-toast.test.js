// A create or edit in a read-only (secondary) tab must TELL the user on screen that the work was
// thrown away — the console error alone is not something anyone is looking at, and the yellow
// banner is dismissable and easy to stop seeing.
//
// multi-tab-guard.js is a classic browser script with no exports and runs entirely at load time, so
// it is evaluated in THIS realm behind a fake window/document/BroadcastChannel and driven through
// the channel, exactly as a second tab would drive it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), '../../frontend/js/multi-tab-guard.js');
const source = readFileSync(GUARD, 'utf8');

function fakeElement(id) {
    const el = {
        id,
        style: {
            _v: {},
            setProperty(k, v) { this._v[k] = v; },
            removeProperty(k) { delete this._v[k]; },
            get top() { return this._v.top; },
            set top(v) { this._v.top = v; }
        },
        children: [],
        className: '',
        textContent: '',
        attrs: {},
        listeners: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        appendChild(child) { this.children.push(child); child.parent = this; return child; },
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        removeEventListener() { },
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.removed = true; },
        getBoundingClientRect: () => ({ top: 0, bottom: 44, left: 0, right: 1000, width: 1000, height: 44 })
    };
    return el;
}

// Boot one guard instance and hand back the levers a test needs. `database`: the page's storage
// database once known (persistent-storage.js databaseName()); null = announced later by an event.
function bootGuard({ database = 'consensus-builder-storage::zagreb' } = {}) {
    const byId = new Map();
    const body = fakeElement('body');
    const doc = {
        body,
        getElementById: id => byId.get(id) || null,
        createElement: () => fakeElement(''),
        addEventListener: () => { },
        querySelectorAll: () => []
    };
    // The guard looks the banner up by id after appending it, so mirror appends into the registry —
    // and drop it again on remove(), because a detached node is exactly what getElementById stops
    // finding, which is what lets attachBanner re-create it.
    const originalAppend = body.appendChild.bind(body);
    body.appendChild = child => {
        const el = originalAppend(child);
        if (el.id) {
            byId.set(el.id, el);
            const originalRemove = el.remove.bind(el);
            el.remove = () => { originalRemove(); if (byId.get(el.id) === el) byId.delete(el.id); };
        }
        return el;
    };

    const toasts = [];
    const channels = [];
    const listeners = {};
    let onmessage = null;
    const scope = {
        document: doc,
        addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
        setTimeout: fn => { fn(); return 0; },
        performance: { now: () => 0 },
        showEphemeralMessage: (text, ms) => toasts.push({ text, ms }),
        PersistentStorage: { databaseName: () => database },
        BroadcastChannel: function (name) {
            channels.push(name);
            this.postMessage = () => { };
            Object.defineProperty(this, 'onmessage', { set(fn) { onmessage = fn; }, get() { return onmessage; } });
        }
    };
    scope.window = scope;

    // eslint-disable-next-line no-new-func
    new Function('window', 'self', 'document', `${source}`)(scope, scope, doc);
    return {
        scope, doc, byId, toasts, channels,
        deliver: msg => onmessage({ data: msg }),
        announce: name => (listeners.persistentstoragedatabase || []).forEach(fn => fn({ detail: { name } }))
    };
}

describe('which tabs are guarded against each other', () => {
    // Each city has its own database (persistent-storage.js): only tabs on the same one can clobber
    // each other, so a tab in another city must not be made read-only.
    it('one channel per database: two cities never meet', () => {
        const zagreb = bootGuard({ database: 'consensus-builder-storage::zagreb' });
        const split = bootGuard({ database: 'consensus-builder-storage::split' });
        expect(zagreb.channels).toEqual(['consensus-builder-tabs:consensus-builder-storage::zagreb']);
        expect(split.channels).toEqual(['consensus-builder-tabs:consensus-builder-storage::split']);
    });

    it('waits for the database to be known before listening at all', () => {
        const late = bootGuard({ database: null });
        expect(late.channels).toEqual([]);
        late.announce('consensus-builder-storage::explore');
        expect(late.channels).toEqual(['consensus-builder-tabs:consensus-builder-storage::explore']);
    });
});

describe('read-only tab write reporting', () => {
    let guard;

    beforeEach(() => {
        guard = bootGuard();
        // Another tab answers our ping: this tab becomes secondary (read-only).
        guard.deliver({ type: 'pong' });
    });

    it('goes read-only and raises the banner when another tab answers', () => {
        expect(guard.scope.__cbSecondaryTab).toBe(true);
        expect(guard.byId.get('cb-multitab-banner')).toBeTruthy();
    });

    it('toasts that the proposal was not saved when a write is dropped', () => {
        guard.scope.__cbReportSecondaryWriteBlocked();
        expect(guard.toasts).toHaveLength(1);
        expect(guard.toasts[0].text).toMatch(/NOT saved/i);
        expect(guard.toasts[0].text).toMatch(/reload/i);
        // Never the raw i18n key, which is what a missing translation resolves to.
        expect(guard.toasts[0].text).not.toContain('multitab.');
    });

    it('does not spam: one user action triggers several saves', () => {
        guard.scope.__cbReportSecondaryWriteBlocked();
        guard.scope.__cbReportSecondaryWriteBlocked();
        guard.scope.__cbReportSecondaryWriteBlocked();
        expect(guard.toasts).toHaveLength(1);
    });

    it('brings the dismissed banner back, because work is being lost right now', () => {
        const banner = guard.byId.get('cb-multitab-banner');
        const dismiss = banner.children.find(c => c.listeners.click);
        dismiss.listeners.click[0]();
        expect(banner.removed).toBe(true);

        guard.scope.__cbReportSecondaryWriteBlocked();
        expect(guard.byId.get('cb-multitab-banner').removed).toBeFalsy();
    });

    it('pushes the toast clear of the banner instead of under it', () => {
        const container = fakeElement('ephemeral-message-container');
        guard.byId.set('ephemeral-message-container', container);

        guard.scope.__cbReportSecondaryWriteBlocked();

        // Banner bottom is 44px in the stub, so the toast may not sit at the CSS default of 20px.
        expect(container.style.top).toBe('56px');
    });

    it('says nothing at all in a tab that owns the store', () => {
        const alone = bootGuard();
        alone.scope.__cbReportSecondaryWriteBlocked();
        expect(alone.toasts).toEqual([]);
        expect(alone.byId.get('cb-multitab-banner')).toBeFalsy();
    });
});
