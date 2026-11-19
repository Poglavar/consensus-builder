import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const { prepare, planLand, explainRefusal } = require('../../frontend/js/plan-analysis.js');

const snapshot = { cid: 'saved-plan', content: { title: 'Garden plan' },
    designs: [{ cid: 'saved-design', content: { title: 'Original garden' } }],
    designSources: { 'saved-design': { sourceId: 'source-a', snapshotId: 'survey-a' } } };
function ports() {
    const feature = { type: 'Feature', id: 'A', properties: { parcelId: 'A' } };
    return {
        resolve: vi.fn(async () => structuredClone(snapshot)),
        bind: vi.fn(async () => ({ coverage: 'complete', parcels: [{ parcelId: 'A' }], parcelSource: { sourceId: 'source-a' } })),
        parcels: vi.fn(async () => [feature]),
        materialize: vi.fn(async ({ designs }) => ({ records: designs,
            fabric: { entriesForCadastre: vi.fn(() => [feature]) } })),
        siteOf: vi.fn(content => content.site || null),
        unite: vi.fn(features => features[0])
    };
}
const square = (x, y, size, properties = {}) => ({ type: 'Feature', properties,
    geometry: { type: 'Polygon', coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]] } });
const unite = features => features.slice(1).reduce((sum, feature) => turf.union(sum, feature), features[0]);
const areaOf = feature => Math.round(turf.area(feature));

// A plan is measured over the ground its designs take, not every parcel they stand on.
describe('a plan\'s land', () => {
    // A parcel of about 2.2 km × 2.2 km, a park in one corner and a road in the other.
    const parcel = square(15.9, 45.8, 0.02, { parcelId: 'BIG' });
    const park = square(15.901, 45.801, 0.001).geometry;
    const road = square(15.915, 45.815, 0.0005).geometry;

    it('is the union of the designs\' sites, however large the parcel they share', () => {
        const designs = [{ content: { site: park }, parcelIds: ['BIG'] }, { content: { site: road }, parcelIds: ['BIG'] }];
        const land = planLand(designs, [parcel], { siteOf: content => content.site, unite });
        expect(areaOf(land)).toBe(areaOf({ type: 'Feature', geometry: park }) + areaOf({ type: 'Feature', geometry: road }));
        expect(areaOf(land)).toBeLessThan(areaOf(parcel) / 100);
    });

    it('takes a parcel act\'s declared parcels, which are its site, and is null for a plan with no ground', () => {
        const act = [{ content: {}, parcelIds: ['BIG'] }];
        expect(planLand(act, [parcel], { siteOf: () => null, unite })).toEqual(parcel);
        expect(planLand([], [parcel], { siteOf: () => null, unite })).toBeNull();
    });

    it('comes with the prepared plan, from each saved member\'s own site', async () => {
        const deps = ports();
        const site = square(15.901, 45.801, 0.001).geometry;
        deps.resolve.mockResolvedValue({ ...snapshot, designs: [{ cid: 'saved-design', content: { title: 'Park', site } }] });
        const result = await prepare(snapshot, deps);
        expect(deps.siteOf).toHaveBeenCalledWith({ title: 'Park', site });
        expect(result.landFeature).toEqual({ type: 'Feature', properties: {}, geometry: site });
    });
});
describe('exact plan analysis', () => {
    it('binds the saved member revision and its source, never a mutable local member', async () => {
        const deps = ports();
        const result = await prepare({ cid: snapshot.cid }, deps);
        expect(deps.bind).toHaveBeenCalledWith(snapshot.designs[0].content, snapshot.designSources['saved-design']);
        expect(deps.parcels).toHaveBeenCalledWith('source-a', ['A']);
        expect(deps.materialize.mock.calls[0][0].designs).toMatchObject([{ cid: 'saved-design', parcelIds: ['A'] }]);
        expect(result.plan).toEqual(snapshot);
        expect(result.records).toHaveLength(1);
        expect(result.materializedFeatures).toHaveLength(1);
    });
    it('fetches a shared source parcel once for multiple members', async () => {
        const deps = ports();
        deps.resolve.mockResolvedValue({ ...snapshot, designs: [...snapshot.designs, { cid: 'second', content: {} }] });
        await prepare(snapshot, deps);
        expect(deps.parcels).toHaveBeenCalledExactlyOnceWith('source-a', ['A']);
    });
    it('refuses an unavailable binding instead of showing an empty plan', async () => {
        const deps = ports(); deps.bind.mockResolvedValue({ coverage: 'unknown' });
        await expect(prepare(snapshot, deps)).rejects.toThrow('coverage');
        expect(deps.materialize).not.toHaveBeenCalled();
    });
    it('refuses missing source parcels instead of using displayed derived parcels', async () => {
        const deps = ports(); deps.parcels.mockResolvedValue([]);
        await expect(prepare(snapshot, deps)).rejects.toThrow('could not be loaded');
        expect(deps.materialize).not.toHaveBeenCalled();
    });
    it('replays a member on its own device copy’s parcels, which the binding can undercount', async () => {
        // An unpublished parcel layout bound to A whose pieces stand on A, B and C: the map applies
        // it on its declared A, B, C, so the replay must seed and claim the same ground.
        const deps = ports();
        deps.parcels.mockImplementation(async (_source, ids) => ids.map(id => ({ type: 'Feature', id, properties: { parcelId: id } })));
        const declared = vi.fn(cid => (cid === 'saved-design' ? ['C', 'A', 'B', 'A'] : null));
        await prepare(snapshot, { ...deps, declared });
        expect(declared).toHaveBeenCalledWith('saved-design');
        expect(deps.parcels).toHaveBeenCalledWith('source-a', ['A', 'B', 'C']);
        expect(deps.materialize.mock.calls[0][0].designs[0].parcelIds).toEqual(['A', 'B', 'C']);
    });
    it('keeps the binding for a member this device holds no copy of', async () => {
        const deps = ports();
        await prepare(snapshot, { ...deps, declared: () => null });
        expect(deps.materialize.mock.calls[0][0].designs[0].parcelIds).toEqual(['A']);
    });
    it('retains open-ground members without inventing source parcels', async () => {
        const deps = ports(); deps.bind.mockResolvedValue({ coverage: 'none', parcels: [], unsurveyedM2: 200 });
        const result = await prepare(snapshot, deps);
        expect(deps.parcels).not.toHaveBeenCalled();
        expect(result.records[0]).toMatchObject({ cid: 'saved-design', parcelIds: [], binding: { unsurveyedM2: 200 } });
    });
    it("tells a replay refusal in the plan's terms: the member, the plot and the parcel it reaches", async () => {
        const refusal = () => Object.assign(new Error('Replacement parcel A#saved-design-6 lies outside immutable cadastral ground at [1, 2].'),
            { code: 'live-fabric-replacement-outside', parcelId: 'A#saved-design-6', vertex: [1, 2] });
        const b = { type: 'Feature', id: 'B', properties: { parcelId: 'B' } };
        const deps = ports();
        deps.bind.mockResolvedValue({ coverage: 'complete', parcels: [{ parcelId: 'A' }, { parcelId: 'B' }], parcelSource: { sourceId: 'source-a' } });
        deps.parcels.mockResolvedValue([{ type: 'Feature', id: 'A', properties: { parcelId: 'A' } }, b]);
        deps.materialize.mockRejectedValue(refusal());
        // The vertex lies in B, which the member declares: the replay, not the design, is at fault.
        await expect(prepare(snapshot, { ...deps, inside: (vertex, feature) => feature.id === 'B' })).rejects.toThrow(
            '"Original garden": plot 6 lies in its declared parcel B, but the plan replay did not form it there.');
        // The vertex lies in B, loaded for another member but not declared by this one: the design must be saved over it.
        const members = [{ cid: 'saved-design', content: { title: 'Original garden' }, parcelIds: ['A'] }];
        expect(explainRefusal(refusal(), members, [b], (vertex, feature) => feature.id === 'B').message).toBe(
            '"Original garden": plot 6 reaches parcel B, which the design does not declare (its parcels: A). Save the design again over every parcel its plots stand on.');
        // No loaded parcel holds the vertex (the usual case: the plan loads only the declared parcels).
        deps.materialize.mockRejectedValue(refusal());
        await expect(prepare(snapshot, { ...deps, inside: () => false })).rejects.toThrow(/reaches ground outside the parcels the plan was read with \(A, B\)/);
        // Other errors pass through unchanged.
        deps.materialize.mockRejectedValue(new Error('Layout could not form'));
        await expect(prepare(snapshot, deps)).rejects.toThrow('Layout could not form');
    });
});
