// Building eligibility (frontend/js/planning/eligibility.js): Living Tradition's paragraph 17 tests
// from building facts and footprints, with real turf geometry for terraces and footprint areas.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
const require = createRequire(import.meta.url);
const eligibility = require('../../frontend/js/planning/eligibility.js');

const ops = eligibility.turfOps(turf);
const set = eligibility.latest('gb-living-tradition-mansards');
// A house 6 m wide and 12 m deep (72 m²) at x metres east of a London origin; neighbours share walls.
const M_LNG = 1 / (111320 * Math.cos(51.539 * Math.PI / 180)), M_LAT = 1 / 110540;
const house = (x, width = 6, depth = 12) => turf.polygon([[[-0.106 + x * M_LNG, 51.539], [-0.106 + (x + width) * M_LNG, 51.539],
    [-0.106 + (x + width) * M_LNG, 51.539 + depth * M_LAT], [-0.106 + x * M_LNG, 51.539 + depth * M_LAT], [-0.106 + x * M_LNG, 51.539]]]);
const fact = value => ({ value, source: 'osm', key: 'k', raw: String(value) });
const georgian = { built: fact({ from: 1828, to: 1830 }), parapet: fact(true), storeys: fact(3), roof_shape: fact('flat') };
const statuses = result => Object.fromEntries(result.tests.map(test => [test.cite, test.status]));

describe('Living Tradition eligibility', () => {
    const row = [house(0), house(6), house(12)];
    it('passes a parapeted Georgian house in a terrace of three, listing what it cannot check', () => {
        const result = eligibility.evaluate(set, { facts: georgian, footprint: row[1], neighbours: row }, ops);
        expect(result.verdict).toBe('eligible');
        expect(statuses(result)).toEqual({ '17.1': 'pass', '17.2': 'pass', '17.3': 'unchecked', '17.4': 'pass', '17.5': 'pass',
            '17.6': 'pass', '17.7': 'pass', '17.8': 'unchecked', '17.9': 'unchecked', '17.10': 'unchecked' });
        expect(result.tests.find(test => test.id === 'attached').value).toBe(3);
        // 6 × 12 m, as turf measures it on the sphere.
        expect(Math.abs(result.tests.find(test => test.id === 'footprint').value - 72)).toBeLessThanOrEqual(1);
    });
    it('is unknown while a fact is, and never guesses one', () => {
        const result = eligibility.evaluate(set, { facts: { ...georgian, parapet: null, roof_shape: null }, footprint: row[0], neighbours: row }, ops);
        expect(result.verdict).toBe('unknown');
        expect(statuses(result)).toMatchObject({ '17.2': 'unknown', '17.4': 'unknown' });
        // Neighbours not loaded: the terrace test is unknown, not failed.
        expect(statuses(eligibility.evaluate(set, { facts: georgian, footprint: row[0], neighbours: null }, ops))['17.6']).toBe('unknown');
    });
    it('fails each condition the facts or the footprint break', () => {
        const cases = [
            [{ built: fact({ from: 1925, to: 1925 }) }, '17.1'], [{ parapet: fact(false) }, '17.2'], [{ roof_shape: fact('mansard') }, '17.4'],
            [{ storeys: fact(1) }, '17.5'],
        ];
        for (const [change, cite] of cases) {
            const result = eligibility.evaluate(set, { facts: { ...georgian, ...change }, footprint: row[1], neighbours: row }, ops);
            expect(result.verdict, cite).toBe('ineligible');
            expect(statuses(result)[cite], cite).toBe('fail');
        }
        const detached = eligibility.evaluate(set, { facts: georgian, footprint: house(40), neighbours: [...row, house(40)] }, ops);
        expect(statuses(detached)['17.6']).toBe('fail');
        const large = house(0, 10, 12);
        expect(statuses(eligibility.evaluate(set, { facts: georgian, footprint: large, neighbours: [large, house(10)] }, ops))['17.7']).toBe('fail');
    });
    it('reads dates as spans: "before 1913" passes, a span across 1918 is unknown', () => {
        const built = span => statuses(eligibility.evaluate(set, { facts: { ...georgian, built: fact(span) }, footprint: row[1], neighbours: row }, ops))['17.1'];
        expect(built({ from: null, to: 1912 })).toBe('pass');
        expect(built({ from: 1910, to: 1929 })).toBe('unknown');
        expect(built({ from: 1918, to: null })).toBe('fail');
        expect(built({ from: 1650, to: 1690 })).toBe('fail');
    });
    it('a semi-detached pair passes the terrace test', () => {
        const pair = [house(0), house(6)];
        expect(statuses(eligibility.evaluate(set, { facts: georgian, footprint: pair[0], neighbours: pair }, ops))['17.6']).toBe('pass');
    });
    it('applies where the city plans under English planning rules', () => {
        expect(eligibility.forCity(['gb-eng-planning']).map(rule => rule.id)).toEqual(['gb-living-tradition-mansards']);
        expect(eligibility.forCity(['hr-zagreb-gup'])).toEqual([]);
    });
});
