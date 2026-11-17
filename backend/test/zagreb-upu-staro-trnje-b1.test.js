// B-1 keeps the adopted UPU's plot minimum and procedural gates visible without manufacturing massing.
import { describe, expect, it, vi } from 'vitest';
import * as turf from '@turf/turf';
import { b1Constraints, b1Representation, queryZagrebUpuStaroTrnjeB1, readZagrebUpuStaroTrnjeB1Parcel } from '../planning/providers/zagreb-upu-staro-trnje-b1.js';

const geometry = { type: 'Polygon', coordinates: [[[15.98,45.79],[15.981,45.79],[15.981,45.791],[15.98,45.79]]] };
const formedPlot = { type: 'Polygon', coordinates: [[[15.98,45.79],[15.981,45.79],[15.981,45.791],[15.98,45.791],[15.98,45.79]]] };
const buildingLinePlot = turf.buffer(turf.feature(formedPlot), -4, { units: 'meters' }).geometry;
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
        expect(item.metrics).toEqual({ floorAreaM2: null, footprintM2: null, heightM: null });
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

    it('draws one conditional detached mass only on a qualified formed B-1 plot', () => {
        const item = b1Representation(row({ parcel_id: 'HR-335649-3602', reference_inside_b1: false,
            parcel_area_m2: 2668.37, intersection_area_m2: 2469.56, core_intersection_area_m2: 2086.97,
            candidate_building_plot_area_m2: 2469.56, candidate_building_plot_geometry: formedPlot, building_line_geometry: buildingLinePlot }));
        expect(item).toMatchObject({ assessment: { status: 'unresolved', reason: 'b1-reparcelation-and-competition-required' },
            sourceEvidence: { candidateBuildingPlotAreaM2: 2469.56, assumedStoreyHeightM: 3, buildingLineInsetM: 4,
                detachedBoundaryInsetM: 7.5, boundaryTreatment: 'all-edges-conservative', footprintForm: 'compact' },
            metrics: { heightM: 15 } });
        expect(item.volumes).toHaveLength(1);
        const footprint = item.volumes[0].geometry;
        expect(footprint.type).toBe('Polygon');
        expect(turf.booleanWithin(turf.feature(footprint), turf.buffer(turf.feature(formedPlot), -7.5, { units: 'meters' }))).toBe(true);
        expect(turf.booleanWithin(turf.feature(footprint), turf.feature(buildingLinePlot))).toBe(true);
        expect(turf.area(turf.feature(footprint))).toBeLessThanOrEqual(2469.56 * 0.5 + 0.1);
        expect(item.metrics.floorAreaM2).toBeLessThanOrEqual(2469.56 * 2.5 + 0.1);
        expect(item.configurations).toEqual([expect.objectContaining({ id: 'conditional-formed-b1-plot-detached', condition: expect.stringContaining('preparcelation') })]);
        expect(b1Representation(row({ parcel_id: 'HR-335649-3602', parcel_area_m2: 2668.37,
            candidate_building_plot_area_m2: 1999.99, candidate_building_plot_geometry: formedPlot, building_line_geometry: buildingLinePlot })).volumes).toEqual([]);
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
        expect(query.summary).toMatchObject({ cachedResults: 1, withGeometry: 1, withoutGeometry: 0,
            statuses: { unavailable: 1 } });
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
