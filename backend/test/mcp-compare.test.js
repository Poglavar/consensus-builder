import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { agreementObject, communityRule, cidOfObject, outputHash, designObject, mapViewFromGeometry, planForDesigns } from '../agents/agreement-objects.js';
import { authoredAreas } from '../agents/mcp-compare.js';
const require = createRequire(import.meta.url);
const builder = require('../../frontend/js/intent-design.js');
const site = turf.bboxPolygon([-0.1, 51.5, -0.099, 51.501]).geometry;
const parcel = { type: 'Feature', id: 'A', properties: { parcelId: 'A' }, geometry: site };
const park = builder.build({ kind: 'space', spaceKind: 'park', site, city: 'london', authoredAt: '2026-10-23T00:00:00.000Z' }, { turf });
const building = builder.build({ kind: 'building', site, floors: 4, city: 'london', authoredAt: park.authoredAt }, { turf });
const stock = turf.transformScale(parcel, 0.1); stock.properties = { object_id: 'survey-building' };
function toolsFor({ supported = true, truncated = false, omitRegion = false, noStock = false } = {}) {
    const calls = [];
    const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {}, fetchImpl: async (url, init) => {
        const path = new URL(url).pathname; calls.push(path);
        if (path === '/designs/binding') return Response.json({ binding: { coverage: 'complete', parcels: [{ parcelId: 'A' }], unknownM2: 0, unsurveyedM2: 0 } });
        if (path === '/parcel-sources/test') return Response.json({ complete: true, features: [parcel] });
        if (path === `/designs/${cidOfObject(park)}`) return Response.json({ cid: cidOfObject(park), content: park });
        if (path === '/buildings/under') return Response.json({ supported, truncated, regions: omitRegion ? {} : Object.fromEntries(JSON.parse(init.body).regions.map(r => [r.key, noStock ? [] : [stock]])) });
        throw new Error(`Unexpected route ${path}`);
    } });
    return { tools, calls };
}
describe('MCP comparison measurements', () => {
    it('measures parcel takes and deduplicated source demolitions, and previews unpublished inputs', async () => {
        const { tools, calls } = toolsFor();
        const result = await tools.compare({ buildingSourceId:'osm', targets: [park, { design: building }], parcelSourceId: 'test' });
        for (const alternative of result.alternatives) {
            expect(alternative.parcelsTaken).toEqual(['A']);
            expect(alternative.buildingsRemoved).toBe(1);
            expect(alternative.buildingsCut).toBe(0);
            expect(alternative.removedFootprintM2).toBeCloseTo(turf.area(stock));
            expect(alternative.measurementErrors).toEqual([]);
            expect(alternative.previewUrl).toBeNull();
            expect(alternative.draftArtifact.design).toEqual(alternative.cid === cidOfObject(park) ? park : building);
        }
        expect(result.alternatives[1].floorAreaM2).toBeCloseTo(turf.area(building.geometry.buildings[0]) * 4);
        expect(calls).not.toContain('/pins'); expect(calls).not.toContain('/agreements');
    });
    it.each([{ supported: false }, { truncated: true }, { omitRegion: true }])('keeps incomplete stock unknown: %j', async options => {
        const { tools } = toolsFor(options);
        const result = await tools.compare({ buildingSourceId:'osm', targets: [park, building], parcelSourceId: 'test' });
        expect(result.alternatives[0].buildingsRemoved).toBeNull();
        expect(result.alternatives[0].measurementErrors[0].code).toBe('building-coverage-incomplete');
    });
    it('keeps a supported empty source as known zero', async () => {
        const { tools } = toolsFor({ noStock: true });
        const result = await tools.compare({ buildingSourceId:'osm', targets: [park, building], parcelSourceId: 'test' });
        expect(result.alternatives[0].buildingsRemoved).toBe(0);
    });
    it('reports a partial building cut separately from a full removal', async () => {
        const narrow = structuredClone(park);
        narrow.site = narrow.structureProposal.geometry = turf.bboxPolygon([-0.09951, 51.5, -0.09949, 51.501]).geometry;
        const { tools } = toolsFor();
        const result = await tools.compare({ buildingSourceId:'osm', targets: [narrow, park], parcelSourceId: 'test' });
        expect(result.alternatives[0]).toMatchObject({ buildingsRemoved: 0, buildingsCut: 1, measurementErrors: [] });
        expect(result.alternatives[0].removedFootprintM2).toBeGreaterThan(2);
        expect(result.alternatives[0].removedFootprintM2).toBeLessThan(turf.area(stock));
    });
    it('uses the shared per-party land/cash ledger rather than returning a money schedule as a ledger', async () => {
        const ground = require('../../frontend/js/agreement-ground.js');
        const agreementDesign = designObject({ ...park, createdAt: park.authoredAt });
        const designCid = agreementDesign.cid, hash = outputHash(site), areaM2 = ground.areaOf(parcel);
        const { content, plan } = agreementObject({ city: 'london', plan: planForDesigns('Agreement plan', [agreementDesign], mapViewFromGeometry([site], 'london')), designs: [{ cid: designCid }],
            parcels: [{ parcelId: 'A', areaM2, holders: [{ ownerKey: 'party-A', share: 0.5 }, { ownerKey: 'party-B', share: 0.5 }] }],
            outputs: [{ hash, areaM2, fromParcelIds: ['A'], role: 'parcel', producedBy: designCid, geometry: site }],
            allocations: [{ output: hash, to: { kind: 'party', ownerKey: 'party-A' } }],
            // Cash is derived from the area settlement: party-A takes the whole plot and pays party-B for its half.
            money: { currency: 'GBP', lines: [] }, rule: { ...communityRule(), electorate: 'owners', settlement: { method: 'area', rateCentsPerM2: 100, contributionBasisPoints: 0 } } });
        const halfCents = Math.round(areaM2 / 2 * 100);
        const { tools } = toolsFor();
        const result = await tools.compare({ buildingSourceId:'osm', targets: [{ agreement: content, plan, designs: [agreementDesign.content] }, park], parcelSourceId: 'test' });
        expect(content.money.lines).toEqual([{ ownerKey: 'party-A', amountCents: -halfCents }, { ownerKey: 'party-B', amountCents: halfCents }]);
        expect(result.alternatives[0].ledger).toMatchObject({ currency: 'GBP', parties: [
            { ownerKey: 'party-A', contributedM2: areaM2 / 2, assignedM2: areaM2, changeM2: areaM2 / 2, cashCents: -halfCents },
            { ownerKey: 'party-B', contributedM2: areaM2 / 2, assignedM2: 0, changeM2: -areaM2 / 2, cashCents: halfCents }] });
        expect(result.alternatives[0].measurementErrors).toEqual([]);
        expect(result.alternatives[0].draftArtifact.agreement).toEqual(content);
        expect(result.alternatives[0].draftArtifact.plan).toEqual(plan.content);
    });
    it('reads common building floors and does not invent a zero for an unmaterialized rule', () => {
        const design = structuredClone(building); delete design.geometry.buildings[0].properties.floors;
        expect(authoredAreas([design]).floorAreaM2).toBeGreaterThan(0);
        expect(authoredAreas([{ buildingProposal: { parameters: { floors: 6 } } }]).floorAreaM2).toBeNull();
        expect(authoredAreas([park, park]).greenAreaM2).toBeCloseTo(turf.area(parcel));
    });
});
