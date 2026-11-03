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
    it('includes only the active editor summary, never its unsaved geometry', () => {
        const activeEditor = { kind: 'parcel-layout', tab: 'editing', algorithm: 'manual', plotCount: 3, dirty: true, drawing: 'polygon', geometry: { secret: 'unsaved-shape' } };
        const text = contextBlock({ activeEditor });
        expect(dataOf(text).activeEditor).toEqual({ kind: 'parcel-layout', tab: 'editing', algorithm: 'manual', plotCount: 3, dirty: true, drawing: 'polygon' });
        expect(text).not.toContain('unsaved-shape');
    });
});
