import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { agreementObject, communityRule, cidOfObject, outputHash, designObject, mapViewFromGeometry, planForDesigns } from '../agents/agreement-objects.js';
import { authoredAreas, backingOf, existingFloorArea, moneyOf, permittedOf } from '../agents/mcp-compare.js';
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

    it('keeps the floor area of buildings a design extends, and prices only what it adds', () => {
        const raise = structuredClone(building);
        raise.buildingProposal.parameters = { ...(raise.buildingProposal.parameters || {}), mode: 'existing' };
        raise.geometry.buildings.forEach(item => { item.properties = { ...item.properties, floors: 4, height: 12, basedOnExisting: true, existingHeight: 9 }; });
        const areas = authoredAreas([raise]);
        expect(areas.buildingsExtended).toBe(raise.geometry.buildings.length);
        expect(areas.keptFloorAreaM2 / areas.floorAreaM2).toBeCloseTo(0.75, 6);
        expect(authoredAreas([building])).toMatchObject({ keptFloorAreaM2: 0, buildingsExtended: 0 });
        raise.geometry.buildings[0].properties.existingHeight = null;
        expect(authoredAreas([raise]).keptFloorAreaM2).toBeNull();
        const money = moneyOf({ city: 'london', floorAreaM2: 400, keptFloorAreaM2: 300, plots: [{ landAreaM2: 0, replacedFloorAreaM2: 0 }],
            prices: { salePerM2: 8000, constructionPerM2: 3000, landPerM2: 4000, saleTaxShare: 0, devChargePerM2: 0 } });
        expect(money).toMatchObject({ keptFloorAreaM2: 300, builtFloorAreaM2: 100, value: 800000, constructionCost: 300000, acquisitionCost: 0, profit: 500000 });
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

    it('charges the new floor area its all-in cost at the city rates: construction, the plot at its land value when higher, sale tax', async () => {
        const { tools } = toolsFor({ stockBuilding: standing });
        const result = await tools.compare({ buildingSources: ['osm'], targets: [park, { design: building }], parcelSourceId: 'test' });
        const built = result.alternatives[1];
        const removed = existingFloorArea(stock.geometry, standing);
        expect(removed).toBeCloseTo(turf.area(stock) * 3);
        expect(built.removedFloorAreaM2).toBeCloseTo(removed);
        // London, at the site's place (its extent's centre is in Southwark, value band B): the borough's
        // land rate and two-bed rent (2,409 a month ÷ 70 m² × 0.675 net to gross), the band's sale price and
        // construction cost, the editable assumptions for the rest.
        // Southwark's Building Safety Levy on previously developed land, 28.47 per m² of new floor area.
        const sale = 11844, cost = 3730, land = 5385, rent = 23.23, levy = 28.47;
        expect(built.money).toMatchObject({ currency: 'GBP', unit: 'm2-floor', prices: {
            sale: { amount: sale, basis: 'market', sourceId: 'gla-lpvs-2026' }, construction: { amount: cost, basis: 'construction-cost' },
            land: { amount: land, basis: 'policy-appraisal', sourceId: 'uk-mhclg-land-2023', scope: 'E09000028 · Southwark' }, saleTax: { amount: 0 },
            rent: { amount: rent, unit: 'm2-floor-month', sourceId: 'ons-pipr-rent', scope: expect.stringMatching(/^E09000028 · Southwark: two-bed rent 2,409 a month/) },
            devCharge: { amount: levy, unit: 'm2-floor', basis: 'statutory', sourceId: 'uk-building-safety-levy', landCategory: 'previously-developed',
                scope: expect.stringMatching(/^E09000028 · Southwark: previously developed land; 56\.93 on other land/) } } });
        expect(built.money.devCharge).toBeCloseTo(built.floorAreaM2 * levy);
        // One plot, parcel A, all of it the site, with the removed building on it. Its land (5,385 a m²)
        // is worth more than the small building standing on it, so the plot is bought at its land value
        // and the building is not paid for on top.
        expect(built.money.plots).toHaveLength(1);
        expect(built.money.plots[0].landAreaM2).toBeCloseTo(siteM2);
        expect(built.money.plots[0].replacedFloorAreaM2).toBeCloseTo(removed);
        expect(siteM2 * land).toBeGreaterThan(removed * sale);
        expect(built.money.acquisitionCost).toBeCloseTo(siteM2 * land);
        expect(built.money.totalCost).toBeCloseTo(built.floorAreaM2 * (cost + levy) + siteM2 * land);
        expect(built.money.profit).toBeCloseTo(built.floorAreaM2 * sale - built.money.totalCost);
        expect(built.money.profitShare).toBeCloseTo(built.money.profit / built.money.value);
        expect(built.money.annualRent).toBeCloseTo(built.floorAreaM2 * rent * 12);
        expect(built.money.rentYieldOnCost).toBeCloseTo(built.money.annualRent / built.money.totalCost);
        // The park builds nothing: it still buys the plot it clears.
        expect(result.alternatives[0].money.profit).toBeCloseTo(-(siteM2 * land));
        expect(result.warnings.some(text => text.startsWith('Money is a model'))).toBe(true);
    });

    it('uses the prices the caller gives instead, as assumptions, the sale tax as a share', async () => {
        const { tools } = toolsFor({ stockBuilding: standing });
        const result = await tools.compare({ buildingSources: ['osm'], targets: [park, { design: building }], parcelSourceId: 'test',
            prices: { salePerM2: 5000, constructionPerM2: 3000, landPerM2: 100, saleTaxShare: 0.2, rentPerM2Month: 25, devChargePerM2: 50 } });
        const { money, floorAreaM2, removedFloorAreaM2 } = result.alternatives[1];
        expect(money.prices.sale).toEqual({ amount: 5000, currency: 'GBP', basis: 'assumption', sourceId: 'caller' });
        expect(money.prices.land.amount).toBe(100);
        expect(money.saleTax).toBeCloseTo(floorAreaM2 * 5000 * 0.2 / 1.2);
        expect(money.prices.devCharge).toEqual({ amount: 50, currency: 'GBP', basis: 'assumption', sourceId: 'caller' });
        // At 100 a m² of land the building standing on the plot is worth more than its land: the plot
        // is bought at its standing value, its land not again on top.
        expect(removedFloorAreaM2 * 5000).toBeGreaterThan(siteM2 * 100);
        expect(money.acquisitionCost).toBeCloseTo(removedFloorAreaM2 * 5000);
        expect(money.profit).toBeCloseTo(floorAreaM2 * 5000 - (floorAreaM2 * 3050 + money.saleTax + removedFloorAreaM2 * 5000));
        expect(money.annualRent).toBeCloseTo(floorAreaM2 * 25 * 12);
    });

    it('reclaims the VAT inside a city construction cost that includes it, also at a construction price the caller gives', () => {
        const area = { floorAreaM2: 1000, plots: [{ landAreaM2: 500, replacedFloorAreaM2: 0 }] };
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

describe('MCP comparison as Compare plans\' decision sheet', () => {
    const tower = builder.build({ kind: 'building', site, floors: 12, city: 'alatau', authoredAt: park.authoredAt }, { turf });
    const zone = (limit) => ({ id: 'zone-1', role: 'permitted', title: 'Mid-rise zone', areas: [{ geometry: turf.bboxPolygon([-0.2, 51.4, 0.1, 51.6]).geometry }],
        constraints: [{ quantity: 'storeys', bound: 'maximum', value: limit }], assessment: { status: 'allowed' } });
    it('checks the new buildings against the city\'s Permitted source where they stand', async () => {
        const asked = [];
        const read = { request: async (path, query) => { asked.push([path, query.source]); return { items: [zone(9)], truncated: false, nextCursor: null }; } };
        const result = await permittedOf([tower], { read });
        expect(asked).toEqual([['/planning/representations', 'alatau-genplan-727']]);
        expect(result).toMatchObject({ source: 'alatau-genplan-727', state: 'breaks', buildings: 1, breaking: 1 });
        expect(result.breakingFloorAreaM2).toBeCloseTo(turf.area(tower.geometry.buildings[0]) * 12, 0);
        const within = await permittedOf([tower], { read: { request: async () => ({ items: [zone(16)] }) } });
        expect(within.state).toBe('within');
        expect(await permittedOf([park], { read })).toEqual({ state: 'noBuildings' });
    });

    it('lists the agreements on the plan revision, reading crowdfunding progress from the chain, never the index', async () => {
        const row = { cid: 'bafk-round', planCid: 'plan-1', onchain: { chain: 'solana', cluster: 'devnet', account: 'Acc', status: 'active' },
            content: { title: 'Round', sponsor: 'Lead', rule: { electorate: 'investors', binding: true, lens: ['L1'] }, funding: { targetUsdcAtomic: '2500000000' } } };
        const read = { request: async (path, query) => (path === '/agreements' && query.plan === 'plan-1' ? { agreements: [row], hasMore: false } : null) };
        const readFunding = async rows => new Map(rows.map(item => [item.cid, { state: 'read', chainStatus: 'Active', raisedUsdcAtomic: 1000000000n, targetUsdcAtomic: 2500000000n, contributors: 3 }]));
        const backing = await backingOf('plan-1', { read, readFunding });
        expect(backing.agreements[0]).toMatchObject({ cid: 'bafk-round', crowdfunding: true, lead: 'Lead', lensThreshold: 1,
            funding: { state: 'read', raisedUsdcAtomic: '1000000000', targetUsdcAtomic: '2500000000', contributors: 3, source: 'solana' } });
        // JSON-safe: amounts as strings.
        expect(() => JSON.stringify(backing)).not.toThrow();
        const offline = await backingOf('plan-1', { read });
        expect(offline.agreements[0].funding.state).toBe('notRead');
    });
});
