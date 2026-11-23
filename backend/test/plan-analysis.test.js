import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const { prepare, planLand, explainRefusal, bindMembers, localDeclaration } = require('../../frontend/js/plan-analysis.js');

const snapshot = { cid: 'saved-plan', content: { title: 'Garden plan' },
    designs: [{ cid: 'saved-design', content: { title: 'Original garden' } }],
    designSources: { 'saved-design': { sourceId: 'source-a', snapshotId: 'survey-a' } } };
function ports() {
    const feature = { type: 'Feature', id: 'A', properties: { parcelId: 'A' } };
    const deps = {
        resolve: vi.fn(async () => structuredClone(snapshot)),
        bind: vi.fn(async () => ({ coverage: 'complete', parcels: [{ parcelId: 'A' }], parcelSource: { sourceId: 'source-a' } })),
        parcels: vi.fn(async () => [feature]),
        materialize: vi.fn(async ({ designs }) => ({ records: designs,
            fabric: { entriesForCadastre: vi.fn(() => [feature]) } })),
        siteOf: vi.fn(content => content.site || null),
        unite: vi.fn(features => features[0])
    };
    // Every member through `bind`, so a test can state one member's binding.
    deps.bindAll = vi.fn(async members => Promise.all(members.map(member => deps.bind(member.content, member.source))));
    return deps;
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
    it('groups browser binding by source and preserves member order', async () => {
        const calls = [];
        const members = [{ cid: 'a', content: {} }, { cid: 'b', content: {} }, { cid: 'c', content: {} }];
        const result = await bindMembers(members, { sourceOf: member => member.cid === 'c' ? 'source-b' : 'source-a',
            bindOnServer: vi.fn(), bindInBrowser: async (source, group) => { calls.push([source, group.length]); return group.map((_, i) => ({ source, parcels: [{ parcelId: `${source}-${i}` }] })); } });
        expect(calls).toEqual([['source-a', 2], ['source-b', 1]]);
        expect(result.map(row => row.parcels[0].parcelId)).toEqual(['source-a-0', 'source-a-1', 'source-b-0']);
    });
    it('stops before binding when cancellation is already requested', async () => {
        const controller = new AbortController(); controller.abort();
        const bind = vi.fn();
        await expect(bindMembers([{ cid: 'a', content: {} }], { sourceOf: () => 'source-a', bindOnServer: bind, bindInBrowser: bind, signal: controller.signal })).rejects.toThrow();
        expect(bind).not.toHaveBeenCalled();
    });
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
    it('uses the source for an unbound import and honors an authored empty scope', () => {
        const imported = { cadastreParcelIds: [], planFileUnboundCid: 'imported', planFileSource: { sourceId: 'survey' } };
        expect(localDeclaration(imported, 'imported')).toBeNull();
        expect(localDeclaration({ ...imported, binding: { coverage: 'none' } }, 'imported')).toEqual([]);
        expect(localDeclaration(imported, 'edited')).toEqual([]);
        expect(localDeclaration({ cadastreParcelIds: [] }, 'authored')).toEqual([]);
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

// A plan's members are bound per parcel source: a provider's source is read once, in the browser,
// for all the members it binds; a source this API holds is asked per member, a few at a time.
describe('binding a plan\'s members', () => {
    const member = (index, sourceId) => ({ content: { title: `Member ${index}`, index }, source: sourceId ? { sourceId } : null });
    const binding = (index, where) => ({ coverage: 'complete', parcels: [{ parcelId: `P${index}` }], where });

    it('reads each provider source once for all its members, in the browser, and keeps member order', async () => {
        const members = [member(0, 'kz-alatau-pkk'), member(1, 'oss-wfs'), member(2, 'kz-alatau-pkk'), member(3, 'rs-rgz-dkp-parcels'), member(4, 'kz-alatau-pkk')];
        const bindInBrowser = vi.fn(async (_sourceId, group) => group.map(entry => binding(entry.content.index, 'browser')));
        const bindOnServer = vi.fn(async entry => binding(entry.content.index, 'server'));
        const bindings = await bindMembers(members, { sourceOf: entry => entry.source?.sourceId ?? null, bindOnServer, bindInBrowser });
        expect(bindings.map(entry => [entry.parcels[0].parcelId, entry.where]))
            .toEqual([['P0', 'browser'], ['P1', 'server'], ['P2', 'browser'], ['P3', 'browser'], ['P4', 'browser']]);
        expect(bindInBrowser.mock.calls.map(([sourceId, group]) => [sourceId, group.map(entry => entry.content.index)]))
            .toEqual([['kz-alatau-pkk', [0, 2, 4]], ['rs-rgz-dkp-parcels', [3]]]);
        expect(bindOnServer.mock.calls.map(([entry, sourceId]) => [entry.content.index, sourceId])).toEqual([[1, 'oss-wfs']]);
    });

    it('asks this API for its own sources and for none, at most six at a time', async () => {
        const members = Array.from({ length: 20 }, (_, index) => member(index, index % 2 ? 'hr-cadastre' : null));
        let inFlight = 0, most = 0;
        const bindOnServer = vi.fn(async entry => {
            inFlight += 1; most = Math.max(most, inFlight);
            await new Promise(resolve => setImmediate(resolve));
            inFlight -= 1;
            return binding(entry.content.index, 'server');
        });
        const bindings = await bindMembers(members, { sourceOf: entry => entry.source?.sourceId ?? null, bindOnServer, bindInBrowser: vi.fn() });
        expect(most).toBe(6);
        expect(bindings.map(entry => entry.parcels[0].parcelId)).toEqual(members.map((_, index) => `P${index}`));
    });

    it('refuses a browser reading that does not answer every member', async () => {
        await expect(bindMembers([member(0, 'kz-alatau-pkk'), member(1, 'kz-alatau-pkk')], {
            sourceOf: entry => entry.source.sourceId, bindOnServer: vi.fn(),
            bindInBrowser: async () => [binding(0, 'browser')]
        })).rejects.toThrow('Parcel coverage is unavailable.');
    });
});
