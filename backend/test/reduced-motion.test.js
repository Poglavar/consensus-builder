// Locks the contract of frontend/js/reduced-motion.js: it may only ever turn Leaflet
// animation OFF, and when motion is not reduced it must touch nothing at all — that
// inertness is what makes it safe to load on every page with no rendering cost.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/reduced-motion.js', import.meta.url), 'utf8');

// Builds a fake browser global with a spy standing in for Leaflet's class-defaults API.
const run = ({ search = '', reduceMedia = false, withMatchMedia = true, withL = true } = {}) => {
    const calls = [];
    const ctx = {
        URLSearchParams,
        location: { search },
        // Spread into a test-realm object: the vm context has its own Object.prototype,
        // and a strict deep-equal rejects a cross-realm object even with identical contents.
        L: withL ? { Map: { mergeOptions: (opts) => calls.push({ ...opts }) } } : undefined,
    };
    if (withMatchMedia) {
        ctx.matchMedia = (q) => ({ matches: reduceMedia && q.includes('prefers-reduced-motion') });
    }
    runInNewContext(source, ctx);
    return { calls, ctx };
};

describe('reduced-motion', () => {
    it('does nothing when motion is not reduced', () => {
        const { calls, ctx } = run();
        expect(calls).toEqual([]);          // Leaflet defaults never touched
        expect(ctx.__reducedMotion).toBe(false);
    });

    it('disables the three Leaflet animations when the URL override is present', () => {
        const { calls, ctx } = run({ search: '?reduceMotion=1' });
        expect(ctx.__reducedMotion).toBe(true);
        expect(calls).toEqual([
            { zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false },
        ]);
    });

    it('disables them when the OS prefers reduced motion', () => {
        const { calls, ctx } = run({ reduceMedia: true });
        expect(ctx.__reducedMotion).toBe(true);
        expect(calls).toHaveLength(1);
    });

    it('never turns an animation on', () => {
        const { calls } = run({ search: '?reduceMotion' });
        expect(calls).toHaveLength(1); // else the loop below passes vacuously
        for (const opts of calls) {
            for (const v of Object.values(opts)) expect(v).toBe(false);
        }
    });

    it('survives a missing matchMedia and a missing Leaflet', () => {
        expect(() => run({ withMatchMedia: false })).not.toThrow();
        expect(() => run({ search: '?reduceMotion', withL: false })).not.toThrow();
    });
});
