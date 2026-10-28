import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { prepare } = require('../../frontend/js/plan-analysis.js');

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
            fabric: { entriesForCadastre: vi.fn(() => [feature]) } }))
    };
}
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
});
