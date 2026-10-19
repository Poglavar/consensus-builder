import { describe, expect, it } from 'vitest';
import { selectListingUnitReading } from '../floor-plans/original-plan-sources.js';

const unit = id => ({ id, scope: 'unit', wallIds: ['W1'] });
const reading = plans => ({ notPlan: false, plans, issues: [] });
describe('shared drawing unit association', () => {
    it('selects the advertised unit from a shared floor page and leaves the paid response intact', () => {
        const response = reading([unit('S1'), unit('S2'), unit('S3')]);
        const before = structuredClone(response), selected = selectListingUnitReading(response, 'S2');
        expect(selected.plans).toEqual([unit('S2')]);
        expect(selected.issues).toEqual(['Only listing unit S2 was selected from this shared page.']);
        expect(response).toEqual(before);
    });
    it.each(['S3', 'unit-S3'])('withholds another explicit unit %s from an S2 offer', id => {
        expect(selectListingUnitReading(reading([unit(id)]), 'S2')).toMatchObject({ plans: [],
            issues: ['The reading did not isolate listing unit S2; geometry remains unassigned.'] });
    });
    it('does not attach a complete building floor to an individual apartment', () => {
        expect(selectListingUnitReading(reading([{ id: 'S2', scope: 'floor' }]), 'S2').plans).toEqual([]);
    });
    it.each(['s-2', 'unit-S2', 'plan-1'])('accepts a single supported unit with machine identity %s', id => {
        const response = reading([unit(id)]);
        expect(selectListingUnitReading(response, 'S2')).toBe(response);
    });
    it('does not guess which of multiple anonymous regions belongs to the offer', () => {
        expect(selectListingUnitReading(reading([unit('plan-1'), unit('plan-2')]), 'S2').plans).toEqual([]);
    });
    it('keeps project-level and non-plan envelopes for the existing reader to validate', () => {
        const project = reading([{ id: 'ground-floor', scope: 'floor' }]);
        expect(selectListingUnitReading(project, null)).toBe(project);
        const invalid = { notPlan: true, plans: [unit('S3')], issues: [] };
        expect(selectListingUnitReading(invalid, 'S2')).toBe(invalid);
    });
});
