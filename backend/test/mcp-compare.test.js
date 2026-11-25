import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { agreementObject, communityRule, cidOfObject, outputHash, designObject, mapViewFromGeometry, planForDesigns } from '../agents/agreement-objects.js';
import { authoredAreas, existingFloorArea, moneyOf } from '../agents/mcp-compare.js';
const require = createRequire(import.meta.url);
const builder = require('../../frontend/js/intent-design.js');
const site = turf.bboxPolygon([-0.1, 51.5, -0.099, 51.501]).geometry;
const parcel = { type: 'Feature', id: 'A', properties: { parcelId: 'A' }, geometry: site };
const park = builder.build({ kind: 'space', spaceKind: 'park', site, city: 'london', authoredAt: '2026-10-23T00:00:00.000Z' }, { turf });
const building = builder.build({ kind: 'building', site, floors: 4, city: 'london', authoredAt: park.authoredAt }, { turf });
const stock = turf.transformScale(parcel, 0.1); stock.properties = { object_id: 'survey-building' };
function toolsFor({ supported = true, truncated = false, omitRegion = false, noStock = false, stockBuilding = stock } = {}) {
    const calls = [];
    const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {}, fetchImpl: async (url, init) => {
        const path = new URL(url).pathname; calls.push(path);
        if (path === '/designs/binding') return Response.json({ binding: { coverage: 'complete', parcels: [{ parcelId: 'A' }], unknownM2: 0, unsurveyedM2: 0 } });
        if (path === '/parcel-sources/test') return Response.json({ complete: true, features: [parcel] });
        if (path === `/designs/${cidOfObject(park)}`) return Response.json({ cid: cidOfObject(park), content: park });
        if (path === '/buildings/under') return Response.json({ supported, truncated, regions: omitRegion ? {} : Object.fromEntries(JSON.parse(init.body).regions.map(r => [r.key, noStock ? [] : [stockBuilding]])) });
        throw new Error(`Unexpected route ${path}`);
    } });
    return { tools, calls };
}
describe('MCP comparison measurements', () => {
    it('measures parcel takes and deduplicated source demolitions, and previews unpublished inputs', async () => {
        const { tools, calls } = toolsFor();
        const result = await tools.compare({ buildingSources:['osm'], targets: [park, { design: building }], parcelSourceId: 'test' });
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
        const result = await tools.compare({ buildingSources:['osm'], targets: [park, building], parcelSourceId: 'test' });
        expect(result.alternatives[0].buildingsRemoved).toBeNull();
        expect(result.alternatives[0].measurementErrors[0].code).toBe('building-coverage-incomplete');
    });
    it('keeps a supported empty source as known zero', async () => {
        const { tools } = toolsFor({ noStock: true });
        const result = await tools.compare({ buildingSources:['osm'], targets: [park, building], parcelSourceId: 'test' });
        expect(result.alternatives[0].buildingsRemoved).toBe(0);
    });
    it('reports a partial building cut separately from a full removal', async () => {
        const narrow = structuredClone(park);
        narrow.site = narrow.structureProposal.geometry = turf.bboxPolygon([-0.09951, 51.5, -0.09949, 51.501]).geometry;
        const { tools } = toolsFor();
        const result = await tools.compare({ buildingSources:['osm'], targets: [narrow, park], parcelSourceId: 'test' });
        expect(result.alternatives[0]).toMatchObject({ buildingsRemoved: 0, buildingsCut: 1, measurementErrors: [] });
        expect(result.alternatives[0].removedFootprintM2).toBeGreaterThan(2);
        expect(result.alternatives[0].removedFootprintM2).toBeLessThan(turf.area(stock));
    });
    it('uses the shared per-party land/cash ledger rather than returning a money schedule as a ledger', async () => {
        const ground = require('../../frontend/js/agreement-ground.js');
        const agreementDesign = designObject({ ...park, createdAt: park.authoredAt });
        const designCid = agreementDesign.cid, hash = outputHash(site), areaM2 = ground.areaOf(parcel);
        // Parcel A is its owners' party; the proposer acquires the plot and the party is paid for its land.
        const { content, plan } = agreementObject({ city: 'london', plan: planForDesigns('Agreement plan', [agreementDesign], mapViewFromGeometry([site], 'london')), designs: [{ cid: designCid }],
            parcels: [{ parcelId: 'A', areaM2 }],
            outputs: [{ hash, areaM2, fromParcelIds: ['A'], role: 'parcel', producedBy: designCid, geometry: site }],
            allocations: [{ output: hash, to: { kind: 'proposer' } }],
            money: { currency: 'GBP', lines: [] }, rule: { ...communityRule(), electorate: 'owners', settlement: { method: 'area', rateCentsPerM2: 100, contributionBasisPoints: 0 } } });
        const cents = Math.round(areaM2 * 100);
        const { tools } = toolsFor();
        const result = await tools.compare({ buildingSources:['osm'], targets: [{ agreement: content, plan, designs: [agreementDesign.content] }, park], parcelSourceId: 'test' });
        expect(content.money.lines).toEqual([{ ownerKey: 'parcel-owner:A', amountCents: cents }]);
        expect(result.alternatives[0].ledger).toMatchObject({ currency: 'GBP', proposerM2: areaM2, parties: [
            { ownerKey: 'parcel-owner:A', parcelId: 'A', contributedM2: areaM2, assignedM2: 0, changeM2: -areaM2, cashCents: cents }] });
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

    it('counts floor area by Plan stats\' rule, so an agent and a person read the same number', () => {
        const planYield = require('../../frontend/js/proposals/plan-yield.js');
        const shaped = properties => ({ ...building, geometry: { ...building.geometry,
            buildings: [{ ...building.geometry.buildings[0], properties } ] } });
        // 11 m with no storey rule: Plan stats counts round(11 / 3) = 4 storeys; a stated count wins.
        for (const design of [shaped({ type: 'proposedBuilding', height: 11 }), shaped({ type: 'proposedBuilding', height: 64, floors: 20 })]) {
            const person = planYield.planYield([{ ...design, applied: true }], { appliedOnly: true }).total.grossFloorAreaM2;
            expect(authoredAreas([design]).floorAreaM2).toBeCloseTo(person);
        }
        expect(authoredAreas([shaped({ type: 'proposedBuilding', height: 11 })]).floorAreaM2)
            .toBeCloseTo(turf.area(building.geometry.buildings[0]) * 4, 0);
        expect(authoredAreas([shaped({ type: 'proposedBuilding' })]).floorAreaM2).toBeNull();
    });
});

describe('MCP comparison money', () => {
    // A three-storey building the source states 9 m tall, as /buildings/under answers it.
    const standing = { id: 'b-1', geometry: stock.geometry, height_m: 9 };
    const siteM2 = turf.area(site);

    it('charges the new floor area its all-in cost at the city rates: construction, land, sale tax, what it removes', async () => {
        const { tools } = toolsFor({ stockBuilding: standing });
        const result = await tools.compare({ buildingSources: ['osm'], targets: [park, { design: building }], parcelSourceId: 'test' });
        const built = result.alternatives[1];
        const removed = existingFloorArea(stock.geometry, standing);
        expect(removed).toBeCloseTo(turf.area(stock) * 3);
        expect(built.removedFloorAreaM2).toBeCloseTo(removed);
        // London, at the site's place (its extent's centre is in Southwark, value band B): the borough's
        // land rate, the band's sale price and construction cost, the editable assumptions for the rest.
        const sale = 11844, cost = 3730, land = 5385;
        expect(built.money).toMatchObject({ currency: 'GBP', unit: 'm2-floor', prices: {
            sale: { amount: sale, basis: 'market', sourceId: 'gla-lpvs-2026' }, construction: { amount: cost, basis: 'construction-cost' },
            land: { amount: land, basis: 'policy-appraisal', sourceId: 'uk-mhclg-land-2023', scope: 'E09000028 · Southwark' }, saleTax: { amount: 0 },
            rent: { amount: 15, unit: 'm2-floor-month' } } });
        expect(built.money.landAreaM2).toBeCloseTo(siteM2);
        expect(built.money.landCost).toBeCloseTo(siteM2 * land);
        expect(built.money.totalCost).toBeCloseTo(built.floorAreaM2 * cost + siteM2 * land + removed * sale);
        expect(built.money.profit).toBeCloseTo(built.floorAreaM2 * sale - built.money.totalCost);
        expect(built.money.annualRent).toBeCloseTo(built.floorAreaM2 * 15 * 12);
        expect(built.money.rentYieldOnCost).toBeCloseTo(built.money.annualRent / built.money.totalCost);
        // The park builds nothing: it still pays for its land and what it clears.
        expect(result.alternatives[0].money.profit).toBeCloseTo(-(siteM2 * land + removed * sale));
        expect(result.warnings.some(text => text.startsWith('Money is a model'))).toBe(true);
    });

    it('uses the prices the caller gives instead, as assumptions, the sale tax as a share', async () => {
        const { tools } = toolsFor({ stockBuilding: standing });
        const result = await tools.compare({ buildingSources: ['osm'], targets: [park, { design: building }], parcelSourceId: 'test',
            prices: { salePerM2: 5000, constructionPerM2: 3000, landPerM2: 100, saleTaxShare: 0.2, rentPerM2Month: 25 } });
        const { money, floorAreaM2, removedFloorAreaM2 } = result.alternatives[1];
        expect(money.prices.sale).toEqual({ amount: 5000, currency: 'GBP', basis: 'assumption', sourceId: 'caller' });
        expect(money.prices.land.amount).toBe(100);
        expect(money.saleTax).toBeCloseTo(floorAreaM2 * 5000 * 0.2 / 1.2);
        expect(money.profit).toBeCloseTo(floorAreaM2 * 5000 - (floorAreaM2 * 3000 + siteM2 * 100 + money.saleTax + removedFloorAreaM2 * 5000));
        expect(money.annualRent).toBeCloseTo(floorAreaM2 * 25 * 12);
    });

    it('reclaims the VAT inside a city construction cost that includes it, also at a construction price the caller gives', () => {
        const area = { floorAreaM2: 1000, replacedFloorAreaM2: 0, landAreaM2: 500 };
        const money = moneyOf({ city: 'astana', ...area });
        expect(money.prices.construction).toMatchObject({ amount: 297900, taxIncluded: true });
        expect(money.taxReclaimed).toBeCloseTo(1000 * 297900 * 0.16 / 1.16);
        expect(money.totalCost).toBeCloseTo(1000 * 297900 + 500 * 54700 + 1000 * 539000 * 0.16 / 1.16 - money.taxReclaimed);
        const given = moneyOf({ city: 'astana', ...area, prices: { constructionPerM2: 320000 } });
        expect(given.prices.construction).toMatchObject({ amount: 320000, sourceId: 'caller', taxIncluded: true });
        expect(given.taxReclaimed).toBeCloseTo(1000 * 320000 * 0.16 / 1.16);
        // London's starting construction cost includes no tax to reclaim.
        expect(moneyOf({ city: 'london', ...area }).taxReclaimed).toBe(0);
    });

    it('leaves the profit unknown when a removed building states no height, and keeps the rest', async () => {
        const { tools } = toolsFor({ stockBuilding: { id: 'b-2', geometry: stock.geometry } });
        const result = await tools.compare({ buildingSources: ['osm'], targets: [park, { design: building }], parcelSourceId: 'test' });
        const built = result.alternatives[1];
        expect(built.removedFloorAreaM2).toBeNull();
        expect(built.money).toMatchObject({ profit: null, totalCost: null });
        // Value band B's 4-6 storey construction cost at the site.
        expect(built.money.constructionCost).toBeCloseTo(built.floorAreaM2 * 3730);
    });
});
