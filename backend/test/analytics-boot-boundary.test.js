// Optional analytics must never delay application startup. A dynamically-created async script is
// still part of the window.load gate when inserted during parsing, and proposal deep links start
// from that gate. Exercise the shipped inline bootstrap so this cannot silently regress.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(
    fileURLToPath(new URL('../../frontend/index.html', import.meta.url)),
    'utf8'
);
const start = html.indexOf('(function (c, l, a, r, i) {');
const end = html.indexOf('</script>', start);
const analyticsBootstrap = html.slice(start, end);

function runBootstrap(hostname = 'consensus.example', readyState = 'loading') {
    const listeners = new Map();
    const idleCallbacks = [];
    const inserted = [];
    const anchor = { parentNode: { insertBefore: script => inserted.push(script) } };
    const document = {
        readyState,
        head: { appendChild: script => inserted.push(script) },
        createElement: vi.fn(tag => ({ tag })),
        getElementsByTagName: vi.fn(() => [anchor])
    };
    const window = {
        location: { hostname },
        addEventListener: vi.fn((type, listener) => listeners.set(type, listener)),
        requestIdleCallback: vi.fn(listener => idleCallbacks.push(listener)),
        setTimeout: vi.fn(listener => idleCallbacks.push(listener))
    };

    // eslint-disable-next-line no-new-func
    new Function('window', 'document', analyticsBootstrap)(window, document);
    return { window, document, listeners, idleCallbacks, inserted };
}

describe('analytics boot boundary', () => {
    it('does not request analytics while application load is pending', () => {
        const state = runBootstrap();

        expect(state.inserted).toHaveLength(0);
        expect(state.document.createElement).not.toHaveBeenCalled();
        expect(state.listeners.has('load')).toBe(true);

        state.listeners.get('load')();
        expect(state.inserted).toHaveLength(0);
        expect(state.idleCallbacks).toHaveLength(1);

        state.idleCallbacks[0]();
        expect(state.inserted).toHaveLength(1);
        expect(state.inserted[0].src).toBe('https://www.clarity.ms/tag/twc9cfoupb');
    });

    it.each(['localhost', '127.0.0.1', '::1'])('never requests analytics on %s', hostname => {
        const state = runBootstrap(hostname);

        expect(state.listeners.has('load')).toBe(true);
        state.listeners.get('load')();
        expect(state.idleCallbacks).toHaveLength(0);
        expect(state.inserted).toHaveLength(0);
    });

    it('schedules analytics after an already-complete document without reinserting it', () => {
        const state = runBootstrap('consensus.example', 'complete');

        expect(state.idleCallbacks).toHaveLength(1);
        state.idleCallbacks[0]();
        state.idleCallbacks[0]();
        expect(state.inserted).toHaveLength(1);
    });
});
