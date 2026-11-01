import { describe, expect, it } from 'vitest';
import { contextBlock } from '../chat/system-prompt.js';
const dataOf = text => JSON.parse(text.match(/<context>\n(.*?)\n<\/context>/s)[1]);
describe('chat context boundaries', () => {
    it('exposes agreement currentness without bearer references or immutable IDs', () => {
        const plan = { cid: 'current-plan', draftRef: 'private-plan' };
        const agreement = { cid: 'agreement-cid', draftRef: 'private-agreement', planCid: plan.cid, title: 'Community support' };
        const text = contextBlock({}, plan, [], agreement);
        expect(dataOf(text).agreement).toEqual({ hasAgreement: true, title: 'Community support', planMatchesWorkingPlan: true });
        expect(text).not.toContain('private-'); expect(text).not.toContain('agreement-cid'); expect(text).not.toContain('current-plan');
        expect(dataOf(contextBlock({}, { cid: 'later' }, [], agreement)).agreement.planMatchesWorkingPlan).toBe(false);
        expect(dataOf(contextBlock({}, null, [], agreement)).agreement.planMatchesWorkingPlan).toBe(false);
    });
});
