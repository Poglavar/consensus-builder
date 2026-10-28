import { describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
import { planCandidates } from '../agents/planner.js';
import { isEligible, selectAlgorithmicPicks } from '../agents/algorithmic-picker.js';
import { findProposalPlan, chooseArea } from '../agents/area-plan.js';
const geometry = turf.bboxPolygon([15, 45, 15.0008, 45.0006]).geometry;
const parcel = { parcelId: 'test-100', geometry, areaM2: turf.area(geometry), buildingCoverage: 'unknown',
    buildingObservations: { buildingCount: 2, footprintM2: 100 }, rule: null };
const persona = { name: 'test-builder', dailyProposals: 1, planningPolicy: 'proposed-design',
    designWeights: { floorArea: 0.65, openSpace: 0.35 }, weights: { density: 1 } };
const plan = (p = parcel, actor = persona) => planCandidates([p], actor, { turf, money: { currency: 'EUR', salePricePerM2: 1000 } });
describe('explicit proposed-design selection', () => {
    it('selects measured geometry while preserving unknown stock and uplift', () => {
        const [candidate] = plan();
        expect(candidate).toMatchObject({ builtKnown: false, builtGfaM2: null, gain: null, offer: null, score: null,
            designPolicy: { kind: 'proposed-design', ruleBasis: 'assumed', score: expect.any(Number) } });
        expect(isEligible(candidate)).toBe(true);
        const picked = selectAlgorithmicPicks({ day: '2026-10-27', persona, candidates: [candidate] });
        expect(picked.picks).toHaveLength(1);
        expect(picked.picks[0].rationale).toContain('design assumes');
        expect(picked.picks[0].rationale).toContain('Existing floor area and net uplift are unknown');
        expect(picked.picks[0].rationale).not.toContain('mapped rule allows');
        expect(selectAlgorithmicPicks({ day: '2026-10-27', persona, candidates: [candidate] })).toEqual(picked);
    });
    it('keeps the uplift policy strict and distinguishes mapped controls', () => {
        expect(isEligible(plan(parcel, { ...persona, planningPolicy: undefined })[0])).toBe(false);
        const [candidate] = plan({ ...parcel, rule: { maxFloors: 4, minSetbackM: 3 } });
        expect(candidate.designPolicy.ruleBasis).toBe('mapped');
        expect(selectAlgorithmicPicks({ persona, candidates: [candidate] }).picks[0].rationale).toContain('mapped rule allows 4 floors');
    });
    it('keeps assumed floors separate from a mapped setback or other partial rule', () => {
        for (const rule of [{ maxFloors: null, minSetbackM: 3 }, { maxCoveragePct: 100 }]) {
            const [candidate] = plan({ ...parcel, rule });
            const rationale = selectAlgorithmicPicks({ persona, candidates: [candidate] }).picks[0].rationale;
            expect(rationale).toContain('design assumes');
            expect(rationale).not.toContain('mapped rule allows');
        }
        const [candidate] = plan({ ...parcel, rule: { maxFloors: 4 } });
        const rationale = selectAlgorithmicPicks({ persona, candidates: [candidate] }).picks[0].rationale;
        expect(rationale).toContain('mapped rule allows 4 floors');
        expect(rationale).toContain('assumed setbacks');
    });
    it('rejects invalid metrics and known loss of floor area', () => {
        const [candidate] = plan();
        for (const designPolicy of [{ ...candidate.designPolicy, score: null }, { ...candidate.designPolicy, openSpaceRatio: 2 },
            { ...candidate.designPolicy, footprintM2: 0 }]) expect(isEligible({ ...candidate, designPolicy })).toBe(false);
        expect(plan({ ...parcel, buildingCoverage: 'complete', buildingSourceId: 'survey-fixture', builtGfaM2: 1e8,
            buildingCount: 1, builtFootprintM2: 100 })).toEqual([]);
    });
});
describe('bounded proposer area search', () => {
    const areas = [{ city: 'first' }, { city: 'second' }, { city: 'third' }, { city: 'fourth' }];
    const result = candidates => ({ parcels: [], preflight: { candidates } });
    it('continues after an ineligible area and source error, retaining diagnostics', async () => {
        const calls = [];
        const [candidate] = plan();
        const selected = await findProposalPlan(areas, '2026-10-27', persona.name, async area => {
            calls.push(area.city);
            if (calls.length === 1) return result([{ candidateId: 'unsupported' }]);
            if (calls.length === 2) throw new Error('provider timeout');
            return result([candidate]);
        });
        expect(calls[0]).toBe(chooseArea(areas, '2026-10-27', persona.name).city);
        expect(calls).toHaveLength(3);
        expect(selected.areaAttempts.map(a => a.outcome)).toEqual(['no-eligible-candidates', 'error', 'selected']);
    });
    it('bounds work to three areas and fails visibly for unresolved source errors', async () => {
        let calls = 0;
        await expect(findProposalPlan(areas, 'day', persona.name, async () => {
            calls++; throw new Error('source unavailable');
        })).rejects.toMatchObject({ name: 'AggregateError', areaAttempts: expect.any(Array) });
        expect(calls).toBe(3);
        const empty = await findProposalPlan(areas, 'day', persona.name, async () => result([]));
        expect(empty.areaAttempts).toHaveLength(3);
        expect(empty.preflight.candidates).toEqual([]);
    });
});
