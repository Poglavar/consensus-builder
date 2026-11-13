// The vendored turf bundle must load and work without generating code at run time, so the site's
// Content-Security-Policy needs no 'unsafe-eval' (scripts/precompile-turf-orientation.mjs).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../frontend/vendor/turf-6.5.0/turf.min.js', import.meta.url), 'utf8');

// A realm where new Function(), Function.apply() and eval() fail, as under a CSP without 'unsafe-eval'.
function loadWithoutEval() {
    const refuse = () => { throw new EvalError('code generation refused (no unsafe-eval)'); };
    const context = vm.createContext({ Function: refuse, eval: refuse });
    context.self = context;
    vm.runInContext(source, context, { filename: 'turf.min.js' });
    return context;
}

// Andrew's monotone chain: the expected hull, computed independently of turf.
function hullKeys(points) {
    const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = list => list.reduce((chain, p) => {
        while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], p) <= 0) chain.pop();
        chain.push(p);
        return chain;
    }, []);
    const lower = half(sorted);
    const upper = half(sorted.reverse());
    return new Set([...lower.slice(0, -1), ...upper.slice(0, -1)].map(p => p.join(',')));
}

describe('vendored turf without eval', () => {
    it('loads when the realm refuses code generation', () => {
        expect(() => loadWithoutEval()).not.toThrow();
    });

    it('turf.convex still returns the exact convex hull', () => {
        const context = loadWithoutEval();
        let seed = 7;
        const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        for (let round = 0; round < 20; round += 1) {
            const points = Array.from({ length: 40 }, () => [Math.round(random() * 1e6) / 1e4, Math.round(random() * 1e6) / 1e4]);
            context.points = JSON.stringify(points);
            const ring = JSON.parse(vm.runInContext(
                'JSON.stringify(turf.convex(turf.featureCollection(JSON.parse(points).map(p => turf.point(p)))).geometry.coordinates[0])',
                context
            ));
            expect(new Set(ring.slice(0, -1).map(p => p.join(',')))).toEqual(hullKeys(points));
        }
    });
});
