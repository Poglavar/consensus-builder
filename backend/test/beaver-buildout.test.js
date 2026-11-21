import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import evaluator from '../../frontend/js/proposals/beaver-buildout.js';
import planFile from '../../frontend/js/plan-file.js';

const member = (cid, properties = {}) => ({
    cid, title: cid, planCompletionMonth: '2028-10', floorM2: 0, spaceM2: 0, unmeasuredBuildings: 0, ...properties
});

describe('Beaver opening assessment', () => {
    const members = [
        member('independent', { floorM2: 1000 }),
        member('dependent', { floorM2: 2000, unmeasuredBuildings: 1 }),
        member('square', { spaceM2: 400 }),
        member('undated', { floorM2: 500, planCompletionMonth: null }),
        member('unserviced', { floorM2: 250 }),
        member('future', { floorM2: 250, planCompletionMonth: '2029-05' })
    ];
    const independent = { access: 'independent', servicing: 'ready' };
    const requires = { access: 'requires-connection', servicing: 'ready' };
    const scenario = { month: '2028-10', assumptions: {
        independent, dependent: requires, square: requires, undated: independent, unserviced: { access: 'independent' }, future: independent
    } };
    it('classifies the month inclusively and calculates how much opening the delay removes', () => {
        const baseline = evaluator.evaluate(members, scenario);
        const delayed = evaluator.evaluate(members, { ...scenario, delayConnection: true });
        expect(baseline.totals.ready).toMatchObject({ floorM2: 3000, spaceM2: 400 });
        expect(delayed.totals.ready).toMatchObject({ floorM2: 1000, spaceM2: 0 });
        expect(delayed.totals.blocked).toMatchObject({ floorM2: 2000, spaceM2: 400, unmeasuredBuildings: 1 });
        expect(delayed.totals.unknown.floorM2).toBe(750);
        expect(delayed.totals.later.floorM2).toBe(250);
        expect(delayed.readyShare).toBe(0.25);
        expect(delayed.lostToDelay).toEqual(delayed.totals.blocked);
    });
    it('keeps dates and services unknown until declared and keeps the authored windows intact', () => {
        const outcome = evaluator.evaluate(members, { ...scenario, assumptions: {
            ...scenario.assumptions, undated: { ...independent, completionMonth: '2028-09' }
        } });
        expect(outcome.members.find(row => row.cid === 'undated')).toMatchObject({
            status: 'ready', completionMonth: '2028-09', planCompletionMonth: null
        });
        expect(outcome.members.find(row => row.cid === 'unserviced')).toMatchObject({ status: 'unknown', reason: 'servicing' });
        expect(members[3].planCompletionMonth).toBeNull();
        expect(() => evaluator.evaluate(members, { ...scenario, assumptions: { wrong: independent } })).toThrow(/outside this plan/);
        expect(() => evaluator.evaluate(members, { ...scenario, month: '2028-13' })).toThrow(/valid assessment month/);
    });
    it.each(['gardens', 'courtyards'])('reads the dated Alatau %s file and finds both first and later phases', name => {
        const file = planFile.parse(readFileSync(new URL(`../../docs/demo/alatau-neighbourhoods/${name}.json`, import.meta.url), 'utf8'));
        expect(Object.keys(file.plan.schedule)).toHaveLength(file.plan.designCids.length);
        const inventory = evaluator.inventory(file.plan, file.designs);
        const outcome = evaluator.evaluate(inventory, { month: '2028-10' });
        expect(outcome.totals.unknown.floorM2).toBeGreaterThan(0);
        expect(outcome.totals.later.floorM2).toBeGreaterThan(0);
        expect(outcome.totals.ready.floorM2).toBe(0);
        expect(inventory.find(member => member.title === 'South · market square')).toMatchObject({
            goal: 'square', planCompletionMonth: '2028-10', spaceM2: expect.any(Number)
        });
    });
});
