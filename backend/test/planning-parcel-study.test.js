// Synthetic parcel studies verify geometry, source-evidence gates and independent edits without network or database writes.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { createAtlasProvider } from '../planning/providers/atlas.js';
import { loadParcelStudy } from '../planning/parcel-study.js';
import { setupPlanningRoutes } from '../routes/planning.js';
const core = createRequire(import.meta.url)('../../frontend/js/planning/parcel-assessment.js');
const metadata = { id: 'atlas-study-test', city: 'colorado', label: 'Synthetic Atlas study', edition: 'test',
    url: 'https://example.test/slices.geojson', parcelSourceId: 'us-co-oit-statewide-parcels' };
const parcel = () => ({ type: 'Feature', id: 'US-COLORADO-STATEWIDE-Boulder~test',
    properties: { sourceId: metadata.parcelSourceId, parcelNumber: 'test' },
    geometry: turf.bboxPolygon([-105.001,40,-105.0005,40.0004]).geometry });
const properties = () => ({ slice_id: 'test', jurisdiction: 'Synthetic', family1_treatment: 'allowed',
    family1_frontsetbackft: 20, family1_frontsetbackft_method: 'estimation',
    family1_sidesetbackft: 5, family1_sidesetbackft_method: 'direct_number',
    family1_rearsetbackft: 10, family1_rearsetbackft_method: 'direct_number',
    family1_maxheightft: 35, family1_maxheightft_method: 'direct_number',
    family1_minlotacres: 0.1, family1_minlotacres_method: 'direct_number',
    family1_maxlotcoverage_building: 50, family1_maxlotcoverage_building_method: 'direct_number' });
const provider = (changes = {}, features) => createAtlasProvider({ type: 'FeatureCollection', features: features || [{
    type: 'Feature', geometry: turf.bboxPolygon([-105.002,39.999,-105,40.001]).geometry, properties: { ...properties(), ...changes }
}] }, metadata);
const query = { city: 'colorado', source: metadata.id, scenario: 'family1', parcel: parcel().id };
const context = (source = provider(), feature = parcel()) => loadParcelStudy(query, {
    sources: [source], parcelProvider: () => ({ queryIds: async () => ({ complete: true, features: [feature] }) })
});
const form = (change = {}) => ({ frontEdge: 0, scale: 0.5, eastM: 0, northM: 0, heightM: 9, ...change });
const assessment = (ctx, change = {}) => {
    const input = form(change); return core.assess(ctx, core.designFromForm(ctx, input, turf), input.frontEdge, turf);
};
const check = (result, key) => result.checks.find(row => row.key === key);

describe('Atlas parcel study', () => {
    it('uses exact parcel and uncut zoning identities and preserves their separate revisions', async () => {
        const ctx = await context();
        expect(ctx.parcel.geometry).toEqual(parcel().geometry);
        expect(ctx.sourceReference).toMatchObject({ recordId: 'test', parcelId: null, scenario: 'family1' });
        expect(ctx.parcelReference).toMatchObject({ sourceId: metadata.parcelSourceId, parcelId: parcel().id });
        expect(ctx.parcelReference.revision).not.toBe(ctx.sourceReference.revision);
        expect(turf.area(ctx.source.site)).toBeGreaterThan(turf.area(ctx.parcel));
    });
    it('derives and checks direct dimensions while estimates remain unknown', async () => {
        const ctx = await context(), result = assessment(ctx);
        expect(result.envelope.heightM).toBeCloseTo(10.668);
        expect(result.envelope.areaM2).toBeLessThan(result.parcelAreaM2);
        expect(check(result, 'frontSetback')).toMatchObject({ status: 'unknown', limit: null, evidence: 'estimated' });
        expect(check(result, 'sideSetback')).toMatchObject({ status: 'pass', limit: 1.524 });
        expect(check(result, 'rearSetback')).toMatchObject({ status: 'pass', limit: 3.048 });
        expect(result.status).toBe('unresolved');
        expect(result.unresolved).toContain('applicability');
    });
    it('height edits independently fail and recover without moving the footprint', async () => {
        const ctx = await context(), low = assessment(ctx), high = assessment(ctx, { heightM: 12 });
        expect(high.design.geometry).toEqual(low.design.geometry);
        expect(check(high, 'height').status).toBe('fail');
        expect(check(high, 'sideSetback')).toEqual(check(low, 'sideSetback'));
        expect(high.status).toBe('breach');
        expect(check(assessment(ctx), 'height').status).toBe('pass');
    });
    it('moving or enlarging a design produces real containment/setback and coverage failures', async () => {
        const ctx = await context(), moved = assessment(ctx, { eastM: 50 }), enlarged = assessment(ctx, { scale: 1.5 });
        expect(check(moved, 'parcelContainment').status).toBe('fail');
        expect(moved.checks.some(row => ['frontSetback', 'sideSetback', 'rearSetback'].includes(row.key) && row.status === 'fail')).toBe(true);
        expect(check(enlarged, 'buildingCoverage').status).toBe('fail');
        expect(check(moved, 'zoningCoverage').status).toBe('unknown');
    });
    it('changing assumed edges reassesses the existing footprint and later height edits keep its basis', async () => {
        const ctx = await context(), basis = core.designFromForm(ctx, form({ scale: 1 }), turf).geometry;
        const before = core.designFromForm(ctx, form(), turf, basis);
        const after = core.designFromForm(ctx, form({ frontEdge: 1, heightM: 12 }), turf, basis);
        expect(after.geometry).toEqual(before.geometry);
        expect(core.assess(ctx, before, 1, turf).design.geometry).toEqual(before.geometry);
    });
    it.each(['estimation', 'indeterminate', 'not_applicable', undefined])('does not turn %s height evidence into a supported extrusion', async method => {
        const ctx = await context(provider({ family1_maxheightft_method: method,
            family1_maxheightft: method === 'indeterminate' ? -1 : method === 'not_applicable' ? null : 35 }));
        expect(core.derive(ctx, 0, turf).heightM).toBeNull();
        expect(check(assessment(ctx), 'height')).toMatchObject({ status: 'unknown', limit: null });
    });
    it('keeps a genuine zero setback while missing minimum lot area remains unknown', async () => {
        const ctx = await context(provider({ family1_sidesetbackft: 0, family1_minlotacres: null }));
        expect(check(assessment(ctx), 'sideSetback').limit).toBe(0);
        expect(check(assessment(ctx), 'lotArea').limit).toBeNull();
    });
    it.each([['hearing', 'unknown'], ['overlay', 'unknown'], ['nomention', 'unknown'], ['prohibited', 'fail']])(
        'keeps %s use distinct from permission', async (treatment, expected) => {
            expect(check(assessment(await context(provider({ family1_treatment: treatment }))), 'use').status).toBe(expected);
        });
    it('clips the displayed bound to source coverage and reports the uncovered parcel area', async () => {
        const source = provider({}, [{ type: 'Feature', properties: properties(), geometry: turf.bboxPolygon([-105.002,39.999,-105.0007,40.001]).geometry }]);
        const ctx = await context(source), result = assessment(ctx);
        expect(ctx.sourceCoverage.uncoveredM2).toBeGreaterThan(100);
        expect(turf.difference(turf.feature(result.envelope.geometry), turf.feature(ctx.coveredGeometry))).toBeNull();
        expect(result.unresolved).toContain('partial-source-coverage');
        expect(ctx.parcel.geometry).toEqual(parcel().geometry);
    });
    it('reads original zoning records even when the display clip has degenerate geometry', async () => {
        const source = provider(), queryOriginal = source.query;
        source.query = async (...args) => {
            const answer = await queryOriginal(...args);
            answer.items[0].site = { type: 'MultiPolygon', coordinates: [[]] };
            return answer;
        };
        expect((await context(source)).source.site.coordinates.length).toBeGreaterThan(0);
    });
    it('refuses multiple intersecting zoning areas rather than choosing a convenient rule set', async () => {
        const first = { type: 'Feature', properties: properties(), geometry: turf.bboxPolygon([-105.002,39.999,-105,40.001]).geometry };
        await expect(context(provider({}, [first, { ...first, properties: { ...properties(), slice_id: 'other' } }]))).rejects.toMatchObject({ code: 'study-multiple-zoning-areas' });
    });
    it('rejects unsupported concavity instead of replacing the source shape', async () => {
        const feature = parcel(); feature.geometry = turf.polygon([[[-105.001,40],[-105.0005,40],[-105.0008,40.0001],[-105.0005,40.0004],[-105.001,40.0004],[-105.001,40]]]).geometry;
        await expect(context(provider(), feature)).rejects.toMatchObject({ code: 'unsupported-parcel-shape' });
    });
    it('rejects ambiguous or incomplete parcel point reads', async () => {
        const options = { sources: [provider()], parcelProvider: () => ({ queryBounds: async () => ({ complete: true, features: [parcel(), { ...parcel(), id: 'another' }] }) }) };
        await expect(loadParcelStudy({ ...query, parcel: undefined, point: [-105.00075,40.0002] }, options)).rejects.toMatchObject({ code: 'study-parcel-ambiguous' });
        options.parcelProvider = () => ({ queryBounds: async () => ({ complete: false, features: [] }) });
        await expect(loadParcelStudy({ ...query, parcel: undefined, point: [-105.00075,40.0002] }, options)).rejects.toMatchObject({ code: 'study-parcel-incomplete' });
    });
    it('invalidates changed parcel and source revisions without rewriting pinned references', async () => {
        const ctx = await context(), saved = { sourceReference: ctx.sourceReference, parcelReference: ctx.parcelReference };
        expect(core.referenceState(saved, ctx)).toBe('same');
        for (const key of ['sourceReference', 'parcelReference']) {
            expect(core.referenceState(saved, { ...ctx, [key]: { ...ctx[key], revision: 'changed' } })).toBe('changed');
        }
        expect(core.referenceState(saved, { ...ctx, sourceReference: { ...ctx.sourceReference, edition: 'another' } })).toBe('changed');
        expect(saved.sourceReference.revision).toBe(ctx.sourceReference.revision);
    });
    it('checks route inputs before invoking source reads', async () => {
        const handlers = {}, calls = [];
        setupPlanningRoutes({ get: (path, fn) => { handlers[path] = fn; } }, {}, { sources: [], studyQuery: async input => { calls.push(input); return { ok: true }; } });
        const res = { code: 200, set() { return this; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
        await handlers['/planning/study']({ query: { city: 'colorado', source: metadata.id, point: 'NaN,40' } }, res);
        expect(res.code).toBe(400); expect(calls).toEqual([]);
        res.code = 200;
        await handlers['/planning/study']({ query }, res);
        expect(res.code).toBe(200); expect(calls[0].parcel).toBe(parcel().id);
    });
});
