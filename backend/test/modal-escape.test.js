// Exercises central Escape ownership across stacked, hidden, disconnected and asynchronous modals.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRouter } = require('../../frontend/js/ui/modal-escape.js');

function fakeDocument() {
    const listeners = new Map();
    return {
        defaultView: { getComputedStyle: element => ({ display: element.display || 'block', visibility: element.visibility || 'visible', zIndex: element.style?.zIndex || '0' }) },
        addEventListener: (type, listener) => listeners.set(type, listener),
        removeEventListener: type => listeners.delete(type),
        escape() {
            const event = { key: 'Escape', defaultPrevented: false, prevented: false, stopped: false,
                preventDefault() { this.defaultPrevented = this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
            listeners.get('keydown')(event); return event;
        }
    };
}

const modal = (zIndex = 0) => ({ isConnected: true, hidden: false, style: { zIndex: String(zIndex) } });

describe('modal Escape router', () => {
    it('closes a nested confirm before its welcome modal, one Escape at a time', () => {
        const doc = fakeDocument(); const router = createRouter(doc); const closed = [];
        const welcome = modal(10);
        const confirm = modal(20);
        router.register(welcome, () => closed.push('welcome'));
        router.register(confirm, () => { closed.push('confirm'); confirm.hidden = true; });
        const event = doc.escape();
        expect(closed).toEqual(['confirm']);
        expect(event).toMatchObject({ prevented: true, stopped: true });
        doc.escape();
        expect(closed).toEqual(['confirm', 'welcome']);
    });

    it('skips hidden or disconnected registrations and respects asynchronous close callbacks', async () => {
        const doc = fakeDocument(); const router = createRouter(doc); const closed = [];
        const hidden = modal(50); hidden.hidden = true;
        const gone = modal(40); gone.isConnected = false;
        router.register(hidden, () => closed.push('hidden'));
        router.register(gone, () => closed.push('gone'));
        router.register(modal(1), async () => { await Promise.resolve(); closed.push('live'); });
        doc.escape();
        await Promise.resolve();
        expect(closed).toEqual(['live']);
        expect(router.size()).toBe(3);
    });

    it('does not select a visible child whose parent modal is hidden', () => {
        const doc = fakeDocument(); const router = createRouter(doc); const closed = [];
        const parent = modal(20); parent.display = 'none';
        const child = modal(30); child.parentElement = parent;
        router.register(child, () => closed.push('hidden-parent'));
        router.register(modal(1), () => closed.push('live'));
        doc.escape();
        expect(closed).toEqual(['live']);
    });
});
