// Build-out state over a plan's construction schedule (frontend/js/buildout-schedule.js) and the
// schedule's place in plan/v1 records (plan-record.js, plan-composition.js).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../../frontend/js/buildout-schedule.js');
const PlanRecord = require('../../frontend/js/plan-record.js');
const a = 'bafkrei' + 'a'.repeat(52), b = 'bafkrei' + 'b'.repeat(52), c = 'bafkrei' + 'c'.repeat(52);
const view = { at: '45.8,15.97,17', mode: '2d' };

describe('build-out state', () => {
    it('counts months and steps across years', () => {
        expect(S.monthIndex('2027-03')).toBe(2027 * 12 + 2);
        expect(S.monthOf(S.monthIndex('2027-12') + 1)).toBe('2028-01');
        expect(S.addMonths('2027-11', 3)).toBe('2028-02');
        expect(S.monthsBetween('2027-03', '2028-10')).toBe(19);
        expect(S.monthIndex('2027-13')).toBeNull();
        expect(S.monthIndex(null)).toBeNull();
        expect(S.currentMonth(new Date(2026, 9, 29))).toBe('2026-10');
    });
    it('is planned before the window, linear during it and built after', () => {
        const window = { start: '2027-01', end: '2027-04' };
        expect(S.stateAt(window, '2026-12')).toEqual({ phase: 'planned', progress: 0 });
        expect(S.stateAt(window, '2027-01')).toEqual({ phase: 'construction', progress: 0.25 });
        expect(S.stateAt(window, '2027-03')).toEqual({ phase: 'construction', progress: 0.75 });
        expect(S.stateAt(window, '2027-04')).toEqual({ phase: 'construction', progress: 1 });
        expect(S.stateAt(window, '2027-05')).toEqual({ phase: 'built', progress: 1 });
        // A missing month or window is the present: everything built.
        expect(S.stateAt(window, null)).toEqual({ phase: 'built', progress: 1 });
        expect(S.stateAt(null, '2027-02')).toEqual({ phase: 'built', progress: 1 });
    });
    it('maps every member, unscheduled ones built at every date', () => {
        const plan = PlanRecord.create('Phased', [a, b, c], view, { [a]: { start: '2027-01', end: '2027-12' }, [b]: { start: '2028-01', end: '2028-06' } });
        const states = S.stateMapAt(plan, '2027-07');
        expect(states.get(a)).toEqual({ phase: 'construction', progress: 7 / 12 });
        expect(states.get(b)).toEqual({ phase: 'planned', progress: 0 });
        expect(states.get(c)).toEqual({ phase: 'built', progress: 1 });
        expect(S.range(plan)).toEqual({ start: '2027-01', end: '2028-06' });
        expect(S.range(PlanRecord.create('Now', [a], view))).toBeNull();
    });
    it('raises floors with progress and shows the ground works first', () => {
        expect(S.builtFloors(8, { phase: 'planned', progress: 0 })).toBe(0);
        expect(S.builtFloors(8, { phase: 'construction', progress: 0.1 })).toBe(0);
        expect(S.builtFloors(8, { phase: 'construction', progress: 0.5 })).toBe(4);
        expect(S.builtFloors(8, { phase: 'construction', progress: 1 })).toBe(8);
        expect(S.builtFloors(8, { phase: 'built', progress: 1 })).toBe(8);
        expect(S.builtFloors(null, { phase: 'built', progress: 1 })).toBe(1);
    });
    it('places Gantt bars as shares of the whole range, in member order', () => {
        const schedule = { [a]: { start: '2027-01', end: '2027-06' }, [b]: { start: '2027-07', end: '2027-12' } };
        expect(S.bars(schedule, [b, a, c])).toEqual([
            { cid: b, start: '2027-07', end: '2027-12', offset: 0.5, width: 0.5 },
            { cid: a, start: '2027-01', end: '2027-06', offset: 0, width: 0.5 }]);
        expect(S.bars({})).toEqual([]);
    });
});

describe('plan/v1 schedule', () => {
    it('keeps an unscheduled plan unchanged and drops windows of non-members', () => {
        const plain = PlanRecord.create('Plan', [a, b], view);
        expect(plain).not.toHaveProperty('schedule');
        expect(PlanRecord.create('Plan', [a, b], view, {})).toEqual(plain);
        const scheduled = PlanRecord.create('Plan', [a, b], view, { [a]: { start: '2027-01', end: '2027-02' }, [c]: { start: '2027-01', end: '2027-02' } });
        expect(scheduled.schedule).toEqual({ [a]: { start: '2027-01', end: '2027-02' } });
        expect(PlanRecord.validate(scheduled)).toBeNull();
    });
    it('refuses windows outside the plan, out of range, reversed or malformed', () => {
        const plan = PlanRecord.create('Plan', [a, b], view);
        const bad = schedule => PlanRecord.validate({ ...plan, schedule });
        expect(bad({})).toMatch(/empty/);
        expect(bad({ [c]: { start: '2027-01', end: '2027-02' } })).toMatch(/not in the plan/);
        expect(bad({ [a]: { start: '2027-05', end: '2027-02' } })).toMatch(/no later than the end/);
        expect(bad({ [a]: { start: '2025-12', end: '2027-02' } })).toMatch(/between 2026-01/);
        expect(bad({ [a]: { start: '2027-1', end: '2027-02' } })).toMatch(/month/);
        expect(bad({ [a]: { start: '2027-01', end: '2027-02', basis: 'permit' } })).toMatch(/month/);
        expect(() => PlanRecord.create('Plan', [a], view, { [a]: { start: '2028-01', end: '2027-01' } })).toThrow(/no later/);
    });
    it('publishes the schedule in the plan JSON Schema', () => {
        const schema = PlanRecord.jsonSchema();
        expect(schema.required).not.toContain('schedule');
        expect(schema.properties.schedule.additionalProperties.required).toEqual(['start', 'end']);
    });
});

const Sim = require('../../frontend/js/buildout-simulation.js');
describe('simulated build-out', () => {
    const sites = [{ key: 'a', floorAreaM2: 0 }, { key: 'b', floorAreaM2: 4000 }, { key: 'c', floorAreaM2: 100000 }];
    it('is repeatable for a seed, differs between seeds, and never moves a site when another is added', () => {
        const one = Sim.simulate(sites, { seed: 'x1', start: '2027-01' });
        expect(Sim.simulate(sites, { seed: 'x1', start: '2027-01' })).toEqual(one);
        expect(Sim.simulate(sites, { seed: 'x2', start: '2027-01' })).not.toEqual(one);
        expect(Sim.simulate([...sites, { key: 'd', floorAreaM2: 10 }], { seed: 'x1', start: '2027-01' }).b).toEqual(one.b);
        for (const window of Object.values(one)) {
            expect(window.start >= '2027-01').toBe(true);
            expect(window.start <= window.end).toBe(true);
        }
    });
    it('takes longer for more floor area, within the cap', () => {
        const months = key => { const w = Sim.simulate(sites, { seed: 's', start: '2027-01' })[key]; return S.monthsBetween(w.start, w.end) + 1; };
        expect(months('a')).toBe(Sim.DEFAULTS.baseMonths);
        expect(months('b')).toBe(Sim.DEFAULTS.baseMonths + 12);
        expect(months('c')).toBe(Sim.DEFAULTS.maxMonths);
    });
    it('starts at the yearly rate: about a quarter of waiting sites start within each year', () => {
        const many = Array.from({ length: 4000 }, (_, i) => ({ key: `site-${i}`, floorAreaM2: 1000 }));
        const windows = Object.values(Sim.simulate(many, { seed: 'rate', start: '2027-01' }));
        const firstYear = windows.filter(w => w.start <= '2027-12').length / many.length;
        expect(firstYear).toBeGreaterThan(0.22); expect(firstYear).toBeLessThan(0.28);
        expect(windows.every(w => S.monthsBetween('2027-01', w.start) <= Sim.DEFAULTS.horizonYears * 12)).toBe(true);
    });
    it('builds an urban rule parcel by parcel, keeps the plan’s own dates and spans each rule member', () => {
        const square = (x, s) => ({ type: 'Polygon', coordinates: [[[x, 0], [x + s, 0], [x + s, s], [x, s], [x, 0]]] });
        const rule = { cid: a, content: { geometry: { ruleMassing: {}, buildings: [{ geometry: square(0, 1), properties: { floors: 4 } }, { geometry: square(2, 1), properties: { floors: 2 } }] } } };
        const park = { cid: b, content: { geometry: {} } };
        const dated = { cid: c, content: { geometry: { buildings: [{ geometry: square(5, 1), properties: { floors: 1 } }] } } };
        const plan = PlanRecord.create('Rule', [a, b, c], view, { [c]: { start: '2026-05', end: '2026-08' } });
        const area = geometry => geometry.coordinates[0][1][0] - geometry.coordinates[0][0][0];
        expect(Sim.sitesOf(plan, [rule, park, dated], { area }).map(site => [site.key, site.floorAreaM2])).toEqual([[`${a}#0`, 4], [`${a}#1`, 2], [b, 0]]);
        const { schedule, buildings } = Sim.scenario(plan, [rule, park, dated], { seed: 'r', start: '2027-01', area });
        expect(schedule[c]).toEqual({ start: '2026-05', end: '2026-08' });
        expect(Object.keys(buildings)).toEqual([a]);
        const parts = Object.values(buildings[a]);
        expect(schedule[a]).toEqual({ start: parts.map(w => w.start).sort()[0], end: parts.map(w => w.end).sort().at(-1) });
        expect(schedule[b]).toBeDefined();
    });
});
