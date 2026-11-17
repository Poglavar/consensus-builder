// B-1 keeps the adopted UPU's plot minimum and procedural gates visible without manufacturing massing.
import { describe, expect, it, vi } from 'vitest';
import { b1Constraints, b1Representation, queryZagrebUpuStaroTrnjeB1, readZagrebUpuStaroTrnjeB1Parcel } from '../planning/providers/zagreb-upu-staro-trnje-b1.js';

const geometry = { type: 'Polygon', coordinates: [[[15.98,45.79],[15.981,45.79],[15.981,45.791],[15.98,45.79]]] };
const row = (changes = {}) => ({ cestica_id: 10, parcel_id: 'HR-335649-3644', parcel_area_m2: 136.3,
    intersection_area_m2: 136.3, core_intersection_area_m2: 136.3, reference_inside_b1: true, parcel_geometry: geometry, ...changes });

describe('Staro Trnje-Savica B-1 permitted evidence', () => {
    it('marks a contained cadastral parcel below the individual plot minimum without calling it an envelope', () => {
        const item = b1Representation(row());
        expect(item).toMatchObject({ role: 'permitted', site: geometry, volumes: [], source: { parcel: 'HR-335649-3644' },
            assessment: { status: 'unavailable', reason: 'parcel-too-small', requiresLandAssembly: true },
            sourceEvidence: { block: 'B-1', article: 27, procedureArticle: 76, minBuildingPlotAreaM2: 2000,
                assessedParcelAreaM2: 136.3, boundaryRelation: 'inside', boundaryUncertaintyM: 3,
                requiresPreparcellation: true, requiresUrbanDesignCompetition: true } });
        expect(item.metrics).toEqual({ floorAreaM2: null, heightM: null });
    });

    it('keeps a 2,000 m² parcel conditional instead of treating it as fully permitted', () => {
        const item = b1Representation(row({ parcel_area_m2: 2000 }));
        expect(item.assessment).toMatchObject({ status: 'unresolved', reason: 'b1-reparcelation-and-competition-required' });
        expect(item.assessment.reason).not.toBe('parcel-too-small');
        expect(b1Constraints()).toEqual(expect.arrayContaining([
            expect.objectContaining({ quantity: 'lotArea', value: 2000, unit: 'm2', bound: 'minimum' }),
            expect.objectContaining({ quantity: 'siteCoverage', subject: 'building-plot', value: 0.5 }),
            expect.objectContaining({ quantity: 'floorAreaRatioAboveGround', numerator: 'above-ground-GBP', value: 2.5 }),
            expect.objectContaining({ quantity: 'storeys', verticalScope: 'above-ground', sourceWording: 'podrum i 5 etaža', value: 5 })
        ]));
    });

    it('retains a crossing parcel as source evidence and keeps a boundary-only contact neutral', () => {
        expect(b1Representation(row({ reference_inside_b1: false, parcel_area_m2: 1999 }))).toMatchObject({
            sourceEvidence: { boundaryRelation: 'crosses', areaComparison: 'below-minimum' },
            assessment: { status: 'unresolved', reason: 'b1-reparcelation-and-competition-required' }
        });
        expect(b1Representation(row({ core_intersection_area_m2: 0 }))).toMatchObject({
            assessment: { status: 'unresolved', reason: 'plan-boundary-uncertain' },
            sourceEvidence: { boundaryRelation: 'boundary-uncertain' }
        });
        expect(b1Representation(row({ intersection_area_m2: 0.0001 }))).toBeNull();
    });

    it('uses the same evidence for viewport and exact-parcel reads', async () => {
        const pool = { query: vi.fn(async () => ({ rows: [row()] })) };
        const query = await queryZagrebUpuStaroTrnjeB1(pool, { bbox: [15.97,45.78,15.99,45.80], limit: 10 });
        const parcel = await readZagrebUpuStaroTrnjeB1Parcel(pool, { parcel: 'HR-335649-3644' });
        expect(query.items[0].sourceEvidence).toEqual(parcel[0].sourceEvidence);
        expect(pool.query.mock.calls[0][1].slice(1,5)).toEqual([15.97,45.78,15.99,45.80]);
        expect(pool.query.mock.calls[1][1].slice(1)).toEqual([335649, '3644']);
    });

    it('rejects a malformed source cursor before issuing SQL', async () => {
        const pool = { query: vi.fn() };
        await expect(queryZagrebUpuStaroTrnjeB1(pool, { bbox: [15.97,45.78,15.99,45.80], after: 'not-a-number' }))
            .rejects.toMatchObject({ status: 400 });
        expect(pool.query).not.toHaveBeenCalled();
    });
});
