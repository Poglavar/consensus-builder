import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const source = readFileSync(path.join(REPO, 'frontend/js/world/handoff.js'), 'utf8');

class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn)); }
    dispatchEvent(event) { event.target = this; for (const fn of [...(this.listeners.get(event.type) || [])]) fn(event); return true; }
}

class Classes {
    constructor() { this.values = new Set(); }
    add(value) { this.values.add(value); }
    contains(value) { return this.values.has(value); }
}

function harness({ proposalId = null, reducedMotion = true, tilesLoading = true } = {}) {
    const win = new Events();
    const children = [];
    const body = { appendChild(node) { children.push(node); node.parentNode = body; }, classList: new Classes() };
    const document = Object.assign(new Events(), {
        body,
        createElement: () => {
            const node = Object.assign(new Events(), {
                className: '', children: [], attributes: {},
                classList: new Classes(),
                setAttribute(key, value) { this.attributes[key] = value; },
                appendChild(child) { this.children.push(child); },
                remove() { this.removed = true; children.splice(children.indexOf(this), 1); }
            });
            return node;
        }
    });
    const values = new Map([['cb_world_handoff', JSON.stringify({
        dataUrl: 'data:image/png;base64,abc', cityId: 'zagreb', at: Date.now(),
        ...(proposalId ? { proposalId } : {})
    })]]);
    let bootResolve;
    const booted = new Promise(resolve => { bootResolve = resolve; });
    let tileResolve;
    const tile = {
        isLoading: () => tilesLoading,
        once: (name, fn) => { if (name === 'load') tileResolve = fn; }
    };
    class GridLayer {}
    Object.setPrototypeOf(tile, GridLayer.prototype);
    win.sessionStorage = {
        getItem: key => values.get(key) || null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key)
    };
    win.location = { search: '' };
    win.whenAppBooted = () => booted;
    win.map = { eachLayer: fn => fn(tile) };
    win.L = { GridLayer };
    win.prefersReducedMotion = () => reducedMotion;
    win.__reducedMotion = false;
    const context = { window: win, document, console: { log() {}, warn() {}, error() {} }, Date, URLSearchParams, Promise, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } };
    vm.runInNewContext(source, context);
    return {
        win, document, children, boot: bootResolve,
        tilesReady: () => tileResolve && tileResolve(),
        ready: proposalIdValue => win.WorldHandoff.proposalReady(proposalIdValue),
        transitionEnd: () => children[0]?.dispatchEvent({ type: 'transitionend', target: children[0] })
    };
}

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

describe('world handoff proposal readiness', () => {
    it('keeps a stored proposal frame covered after app boot until proposal readiness', async () => {
        const h = harness({ proposalId: 'p-1' });
        h.boot();
        await flush();
        expect(h.children).toHaveLength(1);
        expect(h.children[0].classList.contains('world-handoff--out')).toBe(false);
    });

    it('ignores readiness for another proposal', async () => {
        const h = harness({ proposalId: 'p-1' });
        h.boot();
        h.ready('p-2');
        await flush();
        expect(h.children).toHaveLength(1);
        expect(h.children[0].classList.contains('world-handoff--out')).toBe(false);
    });

    it('waits for destination tiles after matching proposal readiness, then removes for reduced motion', async () => {
        const h = harness({ proposalId: 'p-1', reducedMotion: true });
        h.boot();
        h.ready('p-1');
        await flush();
        expect(h.children).toHaveLength(1);
        h.tilesReady();
        await flush();
        expect(h.children).toHaveLength(0);
    });

    it('keeps ordinary handoffs on the existing map-drawn fade path', async () => {
        const h = harness({ reducedMotion: false });
        h.boot();
        await flush();
        expect(h.children[0].classList.contains('world-handoff--out')).toBe(false);
        h.tilesReady();
        await flush();
        expect(h.children[0].classList.contains('world-handoff--out')).toBe(true);
        h.transitionEnd();
        expect(h.children).toHaveLength(0);
    });
});
