// Agent parity for Living Tradition street votes (backend/agents/mcp-ground.js votingWithEligibility):
// the server judges the plan's raised houses from building facts as the app's editor does, refuses
// with each house's failing or unknown tests, and records the check when every house passes.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { votingWithEligibility } from '../agents/mcp-ground.js';
// The same module instance the server requires: a second import would rebind the browser global.
const Eligibility = createRequire(import.meta.url)('../../frontend/js/planning/eligibility.js');

const fact = value => ({ value, source: 'osm', key: 'k', raw: String(value) });
const notListed = { value: { listed: false, grade: null, register: 'National Heritage List for England', reference: null, name: null, url: 'https://www.planning.data.gov.uk/dataset/listed-building', basis: 'none' }, source: 'gb-eng-nhle', key: 'listed-building', raw: 'no entry' };
const georgian = { built: fact({ from: 1828, to: 1830 }), parapet: fact(true), storeys: fact(3), roof_shape: fact('flat'), footprint_m2: fact(45.6), row_size: fact(20), heritage: notListed };
const raised = id => ({ type: 'Feature', geometry: null, properties: { basedOnExisting: true, sourceBuildingId: id, roof: 'mansard' } });
const designs = [{ geometry: { buildings: [raised('w36'), raised('w37')] } }];
const voting = rule => ({ organiser: null, participationUrl: null, voting: { schema: 'community-voting/v2', id: '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7',
    codeHashes: ['a'.repeat(64)], rule } });
const LIVING_TRADITION = { id: 'gb-street-vote-living-tradition', version: '2026-11-27' };

describe('agent street votes under Living Tradition', () => {
    it('refuses while a house is not known eligible, naming the tests', async () => {
        const readFacts = vi.fn(async ids => new Map(ids.map(id => [id, { found: true, facts: id === 'osm:way/37' ? { ...georgian, roof_shape: null } : georgian }])));
        await expect(votingWithEligibility(voting(LIVING_TRADITION), designs, { readFacts })).rejects.toThrow('osm:way/37: unknown [17.4 No existing mansard storey: Unknown]');
        expect(readFacts).toHaveBeenCalledWith(['osm:way/36', 'osm:way/37']);
    });
    it('refuses a Grade II* listed house and leaves an unknown listing unknown, as the app judges them', async () => {
        const starred = { ...notListed, value: { ...notListed.value, listed: true, grade: 'II*', reference: '1195683', url: 'https://historicengland.org.uk/listing/the-list/list-entry/1195683', basis: 'house-number' } };
        const readFacts = async ids => new Map(ids.map(id => [id, { found: true, facts: id === 'osm:way/37' ? { ...georgian, heritage: starred } : { ...georgian, heritage: null } }]));
        const error = await votingWithEligibility(voting(LIVING_TRADITION), designs, { readFacts }).catch(e => e);
        expect(error.code).toBe('eligibility-failed');
        expect(error.message).toContain('osm:way/36: unknown [17.9 Not Grade I or II* listed: Unknown]');
        expect(error.message).toContain('osm:way/37: ineligible [17.9 Not Grade I or II* listed: No, grade II* (Listed, grade II*) — List entry 1195683: https://historicengland.org.uk/listing/the-list/list-entry/1195683]');
        expect(error.constraints.eligibility[1].tests[0]).toMatchObject({ cite: '17.9', status: 'fail', link: { url: 'https://historicengland.org.uk/listing/the-list/list-entry/1195683', text: 'List entry 1195683' } });
    });
    it('gives an agent the reasons and links the building card shows: a register reason with its entry, a key to add', async () => {
        const entry = { reference: '1195683', name: 'NUMBERS 26 TO 50', grade: 'II', url: 'https://historicengland.org.uk/listing/the-list/list-entry/1195683' };
        const edit = { url: 'https://www.openstreetmap.org/edit?editor=id&way=37', source: 'OpenStreetMap', keys: { parapet: 'building:parapet' } };
        const readFacts = async ids => new Map(ids.map(id => [id, id === 'osm:way/37'
            ? { found: true, edit, facts: { ...georgian, parapet: null, heritage: null }, unknown_reasons: { heritage: { code: 'row-uncertain', message: 'x', entries: [entry] } } }
            : { found: true, facts: georgian }]));
        const error = await votingWithEligibility(voting(LIVING_TRADITION), designs, { readFacts }).catch(e => e);
        const [house] = error.constraints.eligibility;
        expect(house).toMatchObject({ id: 'osm:way/37', verdict: 'unknown', edit: edit.url });
        expect(house.tests).toMatchObject([
            { cite: '17.2', status: 'unknown', add: { key: 'building:parapet', source: 'OpenStreetMap', url: edit.url } },
            { cite: '17.9', status: 'unknown', reason: 'A listed entry on this row may cover this house', link: { url: entry.url, text: 'List entry 1195683' } }]);
        expect(error.message).toContain('17.9 Not Grade I or II* listed: Unknown — A listed entry on this row may cover this house — List entry 1195683: https://historicengland.org.uk/listing/the-list/list-entry/1195683');
        expect(error.message).toContain('add building:parapet in OpenStreetMap: https://www.openstreetmap.org/edit?editor=id&way=37');
    });
    it('records the check once every house passes', async () => {
        const readFacts = async ids => new Map(ids.map(id => [id, { found: true, facts: georgian, source_version: { version: 3, changed: '2026-11-27T15:00:00Z' } }]));
        const result = await votingWithEligibility(voting(LIVING_TRADITION), designs, { readFacts });
        expect(result.voting.eligibility.houses.map(house => [house.id, house.verdict])).toEqual([['osm:way/36', 'eligible'], ['osm:way/37', 'eligible']]);
    });
    it('leaves other rules alone and refuses a plan that raises no house with a mansard', async () => {
        const readFacts = vi.fn();
        const other = voting({ id: 'gb-street-vote-strong-suburbs', version: '2026-11-25' });
        expect(await votingWithEligibility(other, designs, { readFacts })).toBe(other);
        await expect(votingWithEligibility(voting(LIVING_TRADITION), [{ geometry: { buildings: [] } }], { readFacts })).rejects.toThrow('nothing to cover');
        expect(readFacts).not.toHaveBeenCalled();
    });
});

// Agent parity for street codes (mcp-ground.js streetCodeCheck): a Strong Suburbs street vote on a
// plan claiming the Strong Suburbs street code gets the same per-building check the editor shows.
describe('agent street votes on a plan claiming a street code', async () => {
    const { streetCodeCheck } = await import('../agents/mcp-ground.js');
    const STRONG_SUBURBS = { id: 'gb-street-vote-strong-suburbs', version: '2026-11-25' };
    const CODE = { id: 'gb-strong-suburbs-street-code', version: '2021' };
    const M_LNG = 1 / (111320 * Math.cos(51.5 * Math.PI / 180)), M_LAT = 1 / 110540;
    const at = (e, n) => [-0.2 + e * M_LNG, 51.5 + n * M_LAT];
    const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[at(w, s), at(e, s), at(e, n), at(w, n), at(w, s)]] });
    const house = { type: 'Feature', geometry: box(30, 5, 36, 15), properties: { type: 'proposedBuilding', basedOnExisting: true, sourceBuildingId: 'w36', height: 9, floorHeightM: 3, roof: 'mansard' } };
    const plan = { schema: 'plan/v1', title: 'Street', designCids: [], view: { at: '51.5,-0.2,17', mode: '2d', city: 'london' }, codes: [CODE] };
    const readers = () => ({ density: async () => ({ areas: [{ scheme: 'GB-MSOA-2021', code: 'E02000001', name: 'Low 001', densityPerHa: 15, geometry: box(-100, -10, 300, 150) }], sources: [] }),
        facts: async ids => new Map(ids.map(id => [id, { found: true, facts: { built: fact({ from: 1931, to: 1931 }), heritage: notListed } }])),
        designations: async () => [], buildingsNear: async () => [] });
    it('reports each building against the claimed code, with what it could not read', async () => {
        const report = await streetCodeCheck(voting(STRONG_SUBURBS), plan, [{ geometry: { buildings: [house] } }], { readers });
        expect(report).toMatchObject({ code: CODE, required: false, summary: { buildings: 1, break: 1, excluded: 0 }, storeyCap: { value: null, bound: 2, reason: 'noStreet' } });
        expect(report.buildings[0]).toMatchObject({ building: 'osm:way/36', verdict: 'breaks' });
        expect(report.recorded).toBeUndefined();
        expect(report.buildings[0].tests[0]).toMatchObject({ cite: '30', status: 'fail', label: 'Storeys within the density cap' });
        expect(report.buildings[0].tests[0].text).toContain('3 storeys');
        // Para 35's light planes are read now (from the plots around; none here, so not known), 51 is not.
        expect(report.notChecked.map(row => row.cite)).toEqual(expect.arrayContaining(['51']));
        expect(report.notChecked.map(row => row.cite)).not.toContain('35');
    });
    // The light planes read every plot around the plan from the designs' parcel source, which the
    // read client needs named: without it no plot is read and every plane test is unknown.
    it('reads the plots around from the parcel source of the plan\'s designs', async () => {
        const { serverReaders } = await import('../agents/mcp-ground.js');
        const asked = [];
        const read = { parcels: async query => { asked.push(query); if (!query.parcelSourceId) throw new Error('Supply an explicit parcelSourceId.');
            return { complete: true, features: [{ id: 'P1', geometry: box(0, 0, 10, 10), properties: {} }] }; } };
        const plots = serverReaders(read, async () => new Map(), 'gb-hmlr-browser-v1')(plan).plots;
        expect(await plots({ bbox: [-0.21, 51.49, -0.19, 51.51] })).toEqual([{ id: 'P1', geometry: box(0, 0, 10, 10) }]);
        expect(asked[0]).toMatchObject({ city: 'london', parcelSourceId: 'gb-hmlr-browser-v1' });
    });
    it('checks nothing when the plan claims no code or the ballot rule carries none', async () => {
        expect(await streetCodeCheck(voting(STRONG_SUBURBS), { ...plan, codes: undefined }, [], { readers })).toBeNull();
        expect(await streetCodeCheck(voting(LIVING_TRADITION), plan, [], { readers })).toBeNull();
    });

    // Strong Suburbs para 2, the 2026-11-27 rule: the vote is held only on a plan that complies.
    const REQUIRED = { id: 'gb-street-vote-strong-suburbs', version: '2026-11-27' };
    const Cid = (await import('../../frontend/js/cid.js')).default;
    const planCid = Cid.cidOfObject(plan);
    it('refuses a plan that does not claim the code the rule requires', async () => {
        const error = await streetCodeCheck(voting(REQUIRED), { ...plan, codes: undefined }, [], { readers, planCid }).catch(e => e);
        expect(error).toMatchObject({ code: 'street-code-unclaimed' });
        expect(error.message).toContain('gb-strong-suburbs-street-code@2021');
        expect(error.next.action).toContain('ugt_edit_plan');
    });
    it('refuses a plan with a building that breaks the code or that it excludes, naming the building and rule', async () => {
        const error = await streetCodeCheck(voting(REQUIRED), plan, [{ geometry: { buildings: [house] } }], { readers, planCid }).catch(e => e);
        expect(error.code).toBe('street-code-failed');
        expect(error.message).toContain('osm:way/36: breaks the code [30 Storeys within the density cap (');
        expect(error.constraints.streetCode.summary).toMatchObject({ break: 1, excluded: 0 });
        const listed = () => ({ ...readers(), facts: async ids => new Map(ids.map(id => [id, { found: true, facts: { built: fact({ from: 1931, to: 1931 }),
            heritage: { ...notListed, value: { ...notListed.value, listed: true, grade: 'II' } } } }])) });
        const excluded = await streetCodeCheck(voting(REQUIRED), plan, [{ geometry: { buildings: [{ ...house, properties: { ...house.properties, height: 6, floorHeightM: 3 } }] } }], { readers: listed, planCid }).catch(e => e);
        expect(excluded.code).toBe('street-code-failed');
        expect(excluded.message).toContain('osm:way/36: excluded by the code [12 ');
    });
    it('records the check when no building breaks the code, however many are not known yet', async () => {
        // Two storeys with no mansard under the bound of 2: the cap passes; ceilings stay unknown.
        const low = { ...house, properties: { ...house.properties, height: 6, floorHeightM: 3, roof: 'flat' } };
        const report = await streetCodeCheck(voting(REQUIRED), plan, [{ geometry: { buildings: [low] } }], { readers, planCid });
        expect(report).toMatchObject({ required: true, summary: { buildings: 1, break: 0, excluded: 0, unknown: 1 } });
        expect(report.recorded).toMatchObject({ set: CODE, planCid, street: null, buildings: [{ factId: 'osm:way/36', verdict: 'unknown', failing: [], excluded: [] }] });
    });
});

// Agent parity for Create Mews (mcp-ground.js streetCodeCheck with a block): a block vote on a plan
// claiming the block code records the check keyed by the block, and names the plots whose owners may
// waive a plane a building pierces.
describe('agent block votes on a plan claiming the Create Mews code', async () => {
    const { streetCodeCheck } = await import('../agents/mcp-ground.js');
    const Cid = (await import('../../frontend/js/cid.js')).default;
    const RULE = { id: 'gb-block-vote-create-mews', version: '2026-11-27' };
    const CODE = { id: 'gb-create-mews-block-code', version: '2022' };
    const M_LNG = 1 / (111320 * Math.cos(51.5 * Math.PI / 180)), M_LAT = 1 / 110540;
    const at = (e, n) => [-0.2 + e * M_LNG, 51.5 + n * M_LAT];
    const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[at(w, s), at(e, s), at(e, n), at(w, n), at(w, s)]] });
    const plots = [['A', 0, 0, 24, 40], ['B', 24, 0, 48, 40], ['C', 0, 40, 24, 80], ['D', 24, 40, 48, 80]].map(([id, ...b]) => ({ id, geometry: box(...b) }));
    const block = { parcelSourceId: 'gb-hmlr-browser-v1', parcelIds: ['A', 'B', 'C', 'D'] };
    const plan = { schema: 'plan/v1', title: 'Mews', designCids: [], view: { at: '51.5,-0.2,17', mode: '2d', city: 'london' }, codes: [CODE] };
    const planCid = Cid.cidOfObject(plan);
    const readers = () => ({ facts: async ids => new Map(ids.map(id => [id, { found: true, facts: { height_m: fact(9) } }])),
        designations: async () => [], buildingsNear: async () => [{ type: 'Feature', id: 'w1', geometry: box(4, 2, 20, 12), properties: {} }],
        plots: async query => plots.filter(plot => !query.parcelIds || query.parcelIds.includes(plot.id)) });
    const cottage = geometry => ({ type: 'Feature', geometry, properties: { type: 'proposedBuilding', height: 5, floors: 2, floorHeightM: 2.5, roof: null } });
    const blockVoting = extra => ({ organiser: null, participationUrl: null, voting: { schema: 'community-voting/v2', id: '0b6f6a52-2f43-4c3e-9a51-0c0d6b1e2f11', codeHashes: ['a'.repeat(64)], rule: RULE, block, ...extra } });
    it('records a waivable cottage on the boundary, naming the plot whose owners may waive each plane', async () => {
        const report = await streetCodeCheck(blockVoting(), plan, [{ geometry: { buildings: [cottage(box(18, 26, 24, 32))] } }], { readers, planCid });
        expect(report.summary).toMatchObject({ buildings: 1, break: 0, waivable: 1 });
        expect(report.buildings[0].waivers.map(row => [row.cite, row.parcels])).toEqual([['26e', ['B']], ['26f', ['B']]]);
        expect(report.recorded).toMatchObject({ set: CODE, planCid, street: Eligibility.blockKey(block), buildings: [{ verdict: 'waivable', failing: ['cmPlotPlane', 'cmPrivacyPlane'] }] });
        expect(report.storeyCap).toBeUndefined();
    });
    it('refuses a cottage over the 20° street plane, and reads no planes without the block', async () => {
        const error = await streetCodeCheck(blockVoting(), plan, [{ geometry: { buildings: [cottage(box(2, 26, 6, 32))] } }], { readers, planCid }).catch(e => e);
        expect(error.code).toBe('street-code-failed');
        expect(error.message).toContain('26a');
        const report = await streetCodeCheck(blockVoting({ block: undefined }), plan, [{ geometry: { buildings: [cottage(box(14, 26, 18, 32))] } }], { readers, planCid });
        expect(report.summary).toMatchObject({ unknown: 1 });
    });
});
