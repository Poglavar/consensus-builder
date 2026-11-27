// Area estimate (backend/area-estimate/estimate.js): cells, street fronting, the mansard a house gains, and the
// sums by verdict tier.
import { describe, it, expect } from 'vitest';
import { cellsOf, centreOf, streetsOf, judgeEligibility, mansardAddedM2, homesIn, summarize, factIdOf, existingHeightOf, plotReader, tallestPassing } from '../area-estimate/estimate.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Eligibility = require('../../frontend/js/planning/eligibility.js');

const M_LON = 1 / (111320 * Math.cos(51.5 * Math.PI / 180)), M_LAT = 1 / 110540;
const at = (x, y) => [-0.1 + x * M_LON, 51.5 + y * M_LAT];
const house = (id, x0, w = 5, d = 10) => ({ type: 'Feature', id, properties: { osm_id: id }, geometry: { type: 'Polygon', coordinates: [[at(x0, 0), at(x0 + w, 0), at(x0 + w, d), at(x0, d), at(x0, 0)]] } });

describe('area estimate', () => {
    it('cuts a box into stable cells', () => {
        const cells = cellsOf([0.001, 51.001, 0.025, 51.012], 0.01);
        expect(cells.map(c => c.key)).toEqual(['0_5100', '1_5100', '2_5100', '0_5101', '1_5101', '2_5101']);
        expect(cells[0].bbox[0]).toBe(0);
    });
    it('assigns each building to the nearest named street within reach', () => {
        const a = house('w1', 0), b = house('w2', 0); b.geometry.coordinates[0] = b.geometry.coordinates[0].map(([x, y]) => [x, y + 200 * M_LAT]);
        const streets = [{ name: 'Front Street', lines: [[at(-20, -5), at(40, -5)]] }];
        const grouped = streetsOf([a, b], streets, 40);
        expect(grouped.get('Front Street').map(f => f.id)).toEqual(['w1']);
        expect(grouped.get('').map(f => f.id)).toEqual(['w2']);
        expect(centreOf(a.geometry)[0]).toBeCloseTo(at(2.5, 5)[0], 9);
    });
    it('gives a terrace house the mansard storey Plan stats measures, and none to an ineligible one', () => {
        const row = [house('w1', 0), house('w2', 5), house('w3', 10)];
        const added = mansardAddedM2(row[1], row);
        expect(added).toBeGreaterThan(25);
        expect(added).toBeLessThan(50);
        const set = Eligibility.get('gb-living-tradition-mansards', '2026-11-27');
        const fact = value => ({ value, source: 'osm' });
        const facts = { built: fact({ from: 1880, to: 1880 }), parapet: fact(true), roof_shape: fact('gabled'), storeys: fact(2), row_size: fact(3),
            footprint_m2: fact(50), heritage: fact({ listed: false }) };
        const eligible = judgeEligibility(set, { facts }, row[1], row);
        expect(eligible.verdict).toBe('eligible');
        expect(eligible.addedM2).toBeCloseTo(added, 6);
        const late = judgeEligibility(set, { facts: { ...facts, built: fact({ from: 1950, to: 1950 }) } }, row[1], row);
        expect(late).toMatchObject({ verdict: 'ineligible', addedM2: 0 });
        expect(late.failing.length).toBeGreaterThan(0);
        const unknown = judgeEligibility(set, { facts: { ...facts, parapet: null } }, row[1], row);
        expect(unknown.verdict).toBe('unknown');
        expect(unknown.unknown).toContain('parapet');
    });
    it('sums the eligible, the possible and those possible with waivers, counting unmeasured and unprofitable apart', () => {
        const money = profit => ({ value: 100, totalCost: 100 - profit, profit });
        const sum = summarize([{ verdict: 'eligible', addedM2: 65, money: money(10) }, { verdict: 'unknown', addedM2: 130, money: money(-5), unknown: ['parapet'] },
            { verdict: 'unknown', addedM2: null, money: null }, { verdict: 'ineligible', addedM2: 0, failing: ['built'] },
            { verdict: 'ineligible', waivable: true, addedM2: 65, money: money(20), failing: ['ssLightPlanes'] }]);
        expect(sum.byVerdict).toEqual({ eligible: 1, unknown: 2, ineligible: 2 });
        expect(sum.tiers.eligible).toMatchObject({ buildings: 1, addedM2: 65, homes: 0, profit: 10, viable: { buildings: 1 } });
        expect(sum.tiers.possible).toMatchObject({ buildings: 3, addedM2: 195, homes: homesIn(195), profit: 5, viable: { buildings: 1, addedM2: 65 } });
        // A building failing only waivable tests counts with the neighbours' waivers, never as possible.
        expect(sum.tiers.withWaivers).toMatchObject({ buildings: 4, addedM2: 260, profit: 25, viable: { buildings: 2, addedM2: 130 } });
        expect(sum.unmeasured).toEqual({ eligible: 0, possible: 1, withWaivers: 1 });
        expect(sum.failingTests).toEqual({ built: 1, ssLightPlanes: 1 });
        expect(homesIn(195)).toBe(2);
    });
    it('takes each building at the tallest height that passes, stepping down only for tests that depend on height', async () => {
        // Building 0 passes at 4; 1 clears its plane only at 2; 2 is excluded (pre-1918) at any height; 3 fails a
        // plane at every height down to its own 3 storeys, so it keeps its result at the cap.
        const judge = async walls => walls.map((w, i) => ({ w, failing: i === 1 && w > 2 ? ['ssLightPlanes'] : i === 2 ? ['ssPre1918', 'ssLightPlanes'] : i === 3 ? ['ssDetached'] : [] }));
        const seen = [];
        const { buildings, calls } = await tallestPassing({ cap: 4, minWalls: [1, 1, 1, 3], heightTests: ['ssLightPlanes', 'ssDetached', 'ssStoreys'],
            judge: async walls => { seen.push(walls); return judge(walls); } });
        expect(buildings.map(b => b.walls)).toEqual([4, 2, 4, 4]);
        expect(buildings[1].result.failing).toEqual([]);
        expect(buildings[3].result).toMatchObject({ w: 4, failing: ['ssDetached'] });
        expect(calls).toBe(3);
        // A building that gave up stands at the cap again for the others' next check.
        expect(seen).toEqual([[4, 4, 4, 4], [4, 3, 4, 3], [4, 2, 4, 4]]);
    });
    it('reads ids and existing heights from the facts contract, never inventing one', () => {
        expect(factIdOf({ properties: { osm_id: 'w42' } })).toBe('osm:way/42');
        expect(factIdOf({ properties: { osm_id: 'r42' } })).toBeNull();
        expect(existingHeightOf({ facts: { height_m: { value: 9 } } })).toBe(9);
        expect(existingHeightOf({ facts: { storeys: { value: 2 } } }, 3.5)).toBe(7);
        expect(existingHeightOf({ facts: { storeys: null, height_m: null } })).toBeNull();
    });
    it('reads the plots of a box a cell at a time, each cell once while it is kept, a plot across cells once', async () => {
        const plot = (id, w, s, e, n) => ({ id, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } });
        const across = plot('X', 0.009, 0.001, 0.011, 0.002), far = plot('F', 0.005, 0.008, 0.006, 0.009);
        const reads = [];
        const readCell = async bbox => { reads.push(bbox.join()); return bbox[0] < 0.005 ? [across, far] : [across]; };
        const plots = plotReader(readCell, { keep: 2 });
        expect((await plots({ bbox: [0.008, 0.0005, 0.012, 0.003] })).map(row => row.id)).toEqual(['X']);
        expect(reads).toHaveLength(2);
        await plots({ bbox: [0.0085, 0.001, 0.0095, 0.002] });
        expect(reads).toHaveLength(2);
        // A third cell pushes out the least recently used (the second), which is read again when asked for.
        await plots({ bbox: [0.021, 0.001, 0.022, 0.002] });
        await plots({ bbox: [0.0085, 0.001, 0.0095, 0.002] });
        expect(reads).toHaveLength(3);
        await plots({ bbox: [0.015, 0.001, 0.016, 0.002] });
        expect(reads).toHaveLength(4);
        await expect(plots({ parcelIds: ['A'] })).rejects.toThrow('by box only');
    });
});
