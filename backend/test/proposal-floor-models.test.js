// Proposal buildings' floor models: read from the shared floor-plan publication by the proposal reference
// ({ city, source: 'proposal', ownerId, buildingId, footprintSha256 }), attached only while the building keeps the
// footprint the plans were drawn for, and never stored back with a published proposal.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { stripLocalProposalState } from '../proposals/archive-state.js';
import { fingerprint, attachProposalFloorModels, nativeFloorModelSource, createPublishedFloorModels, readCityConfigs } from '../buildings/floor-models.js';

const require = createRequire(import.meta.url);
const { validateFloorPlans } = require('../../frontend/js/building-floor-plans.js');
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/podbrezje-a4-published-floor-plans.json', import.meta.url), 'utf8')).plans;
const footprint = (x = 15) => ({ type: 'Polygon', coordinates: [[[x, 45], [x + .001, 45], [x + .001, 45.001], [x, 45]]] });
const ref = (buildingId, extra = {}) => ({ city: 'zagreb', source: 'proposal', ownerId: 'p1', buildingId, footprintSha256: fingerprint(footprint()), ...extra });
// The fixture's plans, bound to one proposal building.
const boundTo = (...refs) => fixture().map(plan => ({ ...plan, buildingRefs: refs }));

// A fake publication: GET /floor-plans answers the plans whose buildingRefs contain { city, source, ownerId?, buildingId }
// for one of the asked ids, as the shared API's containment filter does (it does not look at the footprint).
function fakePublication(plans, { fail = false } = {}) {
    const calls = [];
    const fetch = async url => {
        const query = new URL(url).searchParams;
        calls.push({ path: new URL(url).pathname, ...Object.fromEntries(query) });
        if (fail) throw new Error('connect ECONNREFUSED');
        const ids = (query.get('nativeBuildingIds') ?? query.get('nativeBuildingId')).split(',');
        const all = plans.filter(plan => plan.buildingRefs.some(r => r.city === query.get('city') && r.source === query.get('source')
            && (query.get('ownerId') === null || r.ownerId === query.get('ownerId')) && ids.includes(r.buildingId)));
        const offset = Number(query.get('offset')), limit = Number(query.get('limit'));
        return { ok: true, json: async () => ({ plans: all.slice(offset, offset + limit), limit, offset, hasMore: all.length > offset + limit }) };
    };
    return { calls, published: createPublishedFloorModels({ fetch, cache: new Map(), cityConfigs: readCityConfigs(), log: () => {},
        env: { FLOOR_PLAN_PUBLICATION_API_URL: 'https://publication.test/api' } }) };
}
const proposal = (buildings, extra = {}) => ({ city: 'zagreb', proposalId: 'p1', geometry: { buildings }, ...extra });

describe('proposal floor models from the publication', () => {
    it('attaches the model of the plans that name this proposal, building and current footprint', async () => {
        const { calls, published } = fakePublication(boundTo(ref('b1')));
        const target = proposal([{ geometry: footprint(), properties: { sourceFeatureId: 'b1' } }, { geometry: footprint(16), properties: { sourceFeatureId: 'b2' } }]);
        const report = {};
        await attachProposalFloorModels([target], { published, report });
        const [drawn, other] = target.geometry.buildings;
        expect(validateFloorPlans(drawn.properties.floorPlans)).toEqual([]);
        expect(drawn.properties.floorPlans.storeys.map(storey => storey.level)).toEqual([2, 6]);
        expect(drawn.properties.floorModel).toMatchObject({ city: 'zagreb', source: 'proposal', ownerId: 'p1', buildingId: 'b1', version: null,
            origin: 'publication', footprint: footprint(), publication: { city: 'zagreb', source: 'proposal', ownerId: 'p1', buildingId: 'b1' } });
        expect(other.properties.floorPlans).toBeUndefined();
        // One request for the proposal, by its owner and both buildings.
        expect(calls).toEqual([expect.objectContaining({ path: '/api/floor-plans', city: 'zagreb', source: 'proposal', ownerId: 'p1', nativeBuildingIds: 'b1,b2' })]);
        expect(report.publishedUnavailable).toBeUndefined();
    });

    it('shows nothing once the building\'s footprint is not the one the plans were drawn for', async () => {
        const { published } = fakePublication(boundTo(ref('b1')));
        const moved = proposal([{ geometry: footprint(17), properties: { sourceFeatureId: 'b1' } }]);
        await attachProposalFloorModels([moved], { published });
        expect(moved.geometry.buildings[0].properties.floorPlans).toBeUndefined();
    });

    it('never attaches a same-numbered building of another proposal, and asks nothing for a city without published plans', async () => {
        const { calls, published } = fakePublication(boundTo(ref('b1', { ownerId: 'p2' })));
        const mine = proposal([{ geometry: footprint(), properties: { sourceFeatureId: 'b1' } }]);
        const elsewhere = proposal([{ geometry: footprint(), properties: { sourceFeatureId: 'b1' } }], { city: 'new_york' });
        await attachProposalFloorModels([mine, elsewhere], { published });
        expect(mine.geometry.buildings[0].properties.floorPlans).toBeUndefined();
        expect(elsewhere.geometry.buildings[0].properties.floorPlans).toBeUndefined();
        expect(calls.map(call => call.city)).toEqual(['zagreb']);
        expect(nativeFloorModelSource('building.feed-a', 'custom-3d')).not.toBe(nativeFloorModelSource('building.feed-b', 'custom-3d'));
        expect(nativeFloorModelSource(undefined, 'survey-3d')).toBe('survey-3d');
    });

    it('asks for provider-prefixed DGU and ISPU identities', async () => {
        const { calls, published } = fakePublication([]);
        await attachProposalFloorModels([proposal([{ geometry: footprint(), properties: { dguBuildingId: 123 } },
            { geometry: footprint(16), properties: { sourceLayerId: 123 } }])], { published });
        expect(calls[0].nativeBuildingIds).toBe('dgu-building:123,source-layer:123');
    });

    it('answers without plans when the publication does not answer, and says so', async () => {
        const { published } = fakePublication(boundTo(ref('b1')), { fail: true });
        const target = proposal([{ geometry: footprint(), properties: { sourceFeatureId: 'b1' } }]);
        const report = {};
        await expect(attachProposalFloorModels([target], { published, report })).resolves.toEqual([target]);
        expect(target.geometry.buildings[0].properties.floorPlans).toBeUndefined();
        expect(report.publishedUnavailable).toBe(true);
    });

    it('does not persist API-enriched models when publishing a proposal again', () => {
        const record = { geometry: { buildings: [{ geometry: footprint(), properties: { sourceFeatureId: 'b1', floorPlans: { schema: 'x' }, floorModel: { version: null }, height: 12 } }] } };
        const saved = stripLocalProposalState(record);
        expect(saved.geometry.buildings[0].properties).toEqual({ sourceFeatureId: 'b1', height: 12 });
        expect(record.geometry.buildings[0].properties.floorPlans).toEqual({ schema: 'x' });
    });
});
