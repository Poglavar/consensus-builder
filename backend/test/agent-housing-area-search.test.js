import { describe, it, expect } from 'vitest';
import { findHousingPlan } from '../agents/housing-area-search.js';
import { chooseHousingArea } from '../agents/housing-policy.js';

const areas = [
    {city: 'first', medianMultiple: 14},
    {city: 'second', medianMultiple: 10},
    {city: 'third', medianMultiple: 8}
];
const day = '2026-10-24';
const plan = (area, count = 0) => ({city: area.city, where: area.city, parcels: [], preflight: {candidates: Array.from({length: count}, () => ({city: area.city}))}});
describe('Affordabot bounded city search', () => {
    it('starts with the existing daily priority and stops at a viable plan', async () => {
        const calls = [];
        const found = await findHousingPlan(areas, day, async area => {calls.push(area.city); return plan(area, 1);});
        expect(calls).toEqual([chooseHousingArea(areas, day).city]);
        expect(found.areaAttempts[0].outcome).toBe('selected');
    });
    it('tries another city when parcel fetching fails and records the failure', async () => {
        let calls = 0;
        const found = await findHousingPlan(areas, day, async area => {
            if (++calls === 1) throw new Error('Parcel provider HTTP 400');
            return plan(area, 1);
        });
        expect(calls).toBe(2);
        expect(found.areaAttempts.map(a => a.outcome)).toEqual(['error', 'selected']);
        expect(found.preflight.candidates[0].city).toBe(found.city);
    });
    it('continues when parcels exist but planning or binding yields no candidates', async () => {
        let calls = 0;
        const found = await findHousingPlan(areas, day, async area => {
            const p = plan(area, ++calls === 1 ? 0 : 1); p.parcels = [{id: 'land'}]; return p;
        });
        expect(calls).toBe(2);
        expect(found.areaAttempts[0].outcome).toBe('no-candidates');
    });
    it('returns a legitimate no-picks plan only after every city was checked without errors', async () => {
        const calls = [];
        const found = await findHousingPlan(areas, day, async area => {calls.push(area.city); return plan(area);});
        expect(new Set(calls).size).toBe(3);
        expect(found.preflight.candidates).toEqual([]);
        expect(found.areaAttempts).toHaveLength(3);
    });
    it('does not turn exhausted source errors into a successful no-picks run', async () => {
        let calls = 0;
        await expect(findHousingPlan(areas, day, async area => {
            if (++calls === 1) throw new Error('HTTP 400');
            return plan(area);
        })).rejects.toThrow(/without candidates; 1 area/);
        expect(calls).toBe(3);
    });
    it('does not revisit the same city or loop forever after every source fails', async () => {
        const calls = [];
        await expect(findHousingPlan([...areas, areas[0]], day, async area => {
            calls.push(area.city); throw new Error('source unavailable');
        })).rejects.toThrow(/exhausted 3 cities/);
        expect(calls).toHaveLength(3);
    });
});
