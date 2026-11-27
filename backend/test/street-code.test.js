// Street code check (frontend/js/planning/street-code.js with the rule set in planning/eligibility.js):
// Strong Suburbs' storey cap from the density of the small areas near the street (para 30), its
// setback storey (31–32), ceilings (36), the historic restriction (37) and the exclusions (12–15).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Eligibility = require('../../frontend/js/planning/eligibility.js');
const StreetCode = require('../../frontend/js/planning/street-code.js');

const set = Eligibility.get('gb-strong-suburbs-street-code', '2021');
const M_LNG = 1 / (111320 * Math.cos(51.5 * Math.PI / 180)), M_LAT = 1 / 110540;
const at = (eastM, northM) => [-0.2 + eastM * M_LNG, 51.5 + northM * M_LAT];
const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[at(w, s), at(e, s), at(e, n), at(w, n), at(w, s)]] });
// The street runs 140 m east along y = 0; the house stands 5–15 m north of it.
const street = [[at(0, 0), at(140, 0)]];
const house = (props = {}) => ({ type: 'Feature', geometry: box(30, 5, 36, 15),
    properties: { type: 'proposedBuilding', basedOnExisting: true, sourceBuildingId: 'w36', height: 9, floorHeightM: 3, existingHeight: 6, roof: 'mansard', ...props } });
const area = (code, density, polygon) => ({ scheme: 'GB-MSOA-2021', code, name: code, populationYear: 2024, densityPerHa: density, geometry: polygon });
// A (under the house) 45/ha → 3; B 55 m south 15/ha → 2; C 330 m north 10/ha, out of reach.
const areas = [area('A', 45, box(-100, -10, 300, 150)), area('B', 15, box(-100, -200, 300, -55)), area('C', 10, box(-100, 330, 300, 500))];
const fact = value => ({ value, source: 'osm', key: 'k', raw: String(value) });
const notListed = { value: { listed: false, grade: null }, source: 'gb-eng-nhle', key: 'listed-building', raw: 'no entry' };
const contract = facts => new Map([['osm:way/36', { found: true, facts: { built: fact({ from: 1931, to: 1931 }), storeys: fact(2), heritage: notListed, ...facts } }]]);
const statuses = result => Object.fromEntries(result.tests.map(test => [test.id, test.status]));
const run = (options = {}) => StreetCode.check(set, { designs: [{ geometry: { buildings: [options.house || house()] } }], street: 'street' in options ? options.street : street,
    read: { density: async () => ({ areas: options.areas || areas, sources: [] }), facts: async ids => options.contract || contract({}),
        designations: async (geometry, datasets) => options.designations || [], buildingsNear: async () => options.near || [] } });

describe('Strong Suburbs street code', () => {
    it('is a street code that the Strong Suburbs ballot rule carries, not a building card eligibility', () => {
        expect(set).toMatchObject({ kind: 'street-code', ballotRules: ['gb-street-vote-strong-suburbs'] });
        expect(Eligibility.forCity(['gb-eng-planning']).map(s => s.id)).toEqual(['gb-living-tradition-mansards']);
        expect(Eligibility.forCity(['gb-eng-planning'], { kind: 'street-code' }).map(s => s.id)).toEqual(['gb-strong-suburbs-street-code']);
        expect(Eligibility.codesForBallot({ id: 'gb-street-vote-strong-suburbs' }).map(s => s.id)).toEqual(['gb-strong-suburbs-street-code']);
    });
    it('caps storeys by density bands, the lower end taking the lower cap (para 30)', () => {
        const cap = density => StreetCode.capOf(set.density.bands, density);
        expect([0.06, 19.9, 20, 60, 60.1, 120, 120.1, 287].map(cap)).toEqual([2, 2, 3, 3, 4, 4, 5, 5]);
        expect(cap(null)).toBeNull();
    });
    it('takes the lowest cap of the areas within 200 m of the street or under a building, and none further', async () => {
        const outcome = await run();
        expect(outcome.cap).toMatchObject({ value: 2, lowest: { code: 'B' } });
        expect(outcome.cap.areas.map(a => a.code).sort()).toEqual(['A', 'B']);
        const [building] = outcome.buildings;
        expect(building).toMatchObject({ kind: 'existing', factId: 'osm:way/36', storeys: 3, setbacks: 1, storeyHeightM: 3 });
        // Three storeys plus the mansard over a cap of two: the plan breaks para 30.
        expect(statuses(building.result)).toMatchObject({ ssStoreys: 'fail', ssSetbackPlane: 'pass', ssSetbacks: 'pass', ssListed: 'pass', ssPre1918: 'pass', ssGreenBelt: 'notApplicable' });
        expect(building.result.verdict).toBe('ineligible');
        // Out of reach, the low-density area C changes nothing; within reach a denser B lifts the cap to 3.
        const denser = await run({ areas: [areas[0], area('B', 50, areas[1].geometry), areas[2]] });
        expect(denser.cap.value).toBe(3);
        expect(statuses(denser.buildings[0].result).ssStoreys).toBe('pass');
    });
    it('without the street knows the cap only as a bound: over it fails, within it is unknown', async () => {
        const outcome = await run({ street: null });
        expect(outcome.cap).toMatchObject({ value: null, bound: 3, reason: 'noStreet' });
        expect(statuses(outcome.buildings[0].result).ssStoreys).toBe('unknown');
        const tall = await run({ street: null, house: house({ height: 12 }) });
        expect(tall.buildings[0].result.tests.find(test => test.id === 'ssStoreys')).toMatchObject({ status: 'fail', value: 4, limit: 3 });
        // No density read at all: unknown, never a guessed cap.
        const unread = await StreetCode.check(set, { designs: [{ geometry: { buildings: [house()] } }], street, read: {} });
        expect(unread.cap).toMatchObject({ value: null, reason: 'densityUnread' });
        expect(statuses(unread.buildings[0].result).ssStoreys).toBe('unknown');
    });
    it('counts storeys only from a stated storey height, and judges ceilings from it as a bound (para 36)', async () => {
        const unstated = await run({ house: house({ floorHeightM: undefined }) });
        expect(unstated.buildings[0]).toMatchObject({ storeys: null, storeyHeightM: null });
        expect(statuses(unstated.buildings[0].result)).toMatchObject({ ssStoreys: 'unknown', ssCeilingMax: 'unknown', ssCeilingMin: 'unknown' });
        const ok = statuses((await run({ areas: [area('A', 130, areas[0].geometry)] })).buildings[0].result);
        // A 3 m storey: the ceiling is under 3.5 m; whether it reaches 2.5 m depends on the floor's thickness.
        expect(ok).toMatchObject({ ssStoreys: 'pass', ssCeilingMax: 'pass', ssCeilingMin: 'unknown' });
        const tall = statuses((await run({ house: house({ height: 12, floorHeightM: 4 }) })).buildings[0].result);
        expect(tall).toMatchObject({ ssCeilingMax: 'unknown' });
    });
    it('excludes a listed or pre-1918 building and one in a National Park, AONB or SSSI (paras 12, 13, 15)', async () => {
        const listed = await run({ contract: contract({ heritage: { ...notListed, value: { listed: true, grade: 'II' } } }) });
        expect(listed.buildings[0].result.tests.find(test => test.id === 'ssListed')).toMatchObject({ status: 'fail', grade: 'II' });
        const old = await run({ contract: contract({ built: fact({ from: null, to: 1912 }) }) });
        expect(statuses(old.buildings[0].result).ssPre1918).toBe('fail');
        const unsure = await run({ contract: contract({ built: fact({ from: 1900, to: 1930 }) }) });
        expect(statuses(unsure.buildings[0].result).ssPre1918).toBe('unknown');
        const park = await run({ designations: ['national-park'] });
        expect(statuses(park.buildings[0].result).ssNature).toBe('fail');
        // Green Belt excludes only new building on undeveloped land: a raised house is developed land.
        const belt = await run({ designations: ['green-belt'] });
        expect(statuses(belt.buildings[0].result)).toMatchObject({ ssGreenBelt: 'notApplicable', ssNature: 'pass' });
        const fresh = await run({ designations: ['green-belt'], house: house({ basedOnExisting: false }) });
        expect(statuses(fresh.buildings[0].result)).toMatchObject({ ssGreenBelt: 'fail', ssListed: 'notApplicable' });
    });
    it('restricts to 3+1 with ten pre-1918 buildings within 100 m, and stays unknown while dates could decide it (para 37)', () => {
        const near = (n, built, storeys = 2, northM = 20) => Array.from({ length: n }, (_, i) => ({ id: `w${i}`, geometry: box(i * 8, northM, i * 8 + 6, northM + 8), built, storeys }));
        const old = { from: null, to: 1900 }, modern = { from: 1960, to: 1960 };
        expect(StreetCode.historicLimit(set, { street, near: near(10, old) })).toMatchObject({ value: 3, before1918: 10 });
        expect(StreetCode.historicLimit(set, { street, near: [...near(9, old), ...near(5, modern)] })).toMatchObject({ value: false, before1918: 9 });
        expect(StreetCode.historicLimit(set, { street, near: [...near(9, old), ...near(1, null)] })).toMatchObject({ value: null, reason: 'datesUnknown' });
        // 150 m away they do not count.
        expect(StreetCode.historicLimit(set, { street, near: near(10, old, 2, 150) }).value).toBe(false);
        // Half the street already over 3+1: the existing total applies, which is not measured.
        expect(StreetCode.historicLimit(set, { street, near: near(10, old, 5) })).toMatchObject({ value: null, reason: 'existingTotal' });
    });
    it('explains a failing derived fact with the cap and the area it came from', async () => {
        const outcome = await run();
        const t = (key, params = {}) => `${key}(${Object.values(params).join('|')})`;
        const [row] = StreetCode.describe(set, outcome, t)[0].tests;
        expect(row).toMatchObject({ cite: '30', status: 'fail', text: 'eligibility.fact.proposedStoreys(3) · eligibility.fact.storeyCap(2|15|B)' });
        expect(StreetCode.unchecked(set).map(test => test.cite)).toEqual(['14', '35', '36.2', '39', '41', '42', '51', '52']);
    });
});

// What a Strong Suburbs street vote records of its check (ballot rule requires.streetCode,
// Eligibility.codeEvidence / normalizeCodeEvidence / codeIssues): breaking and excluded buildings
// hold the vote back, buildings the app cannot judge yet do not.
describe('the street code check a street vote records', () => {
    const Cid = require('../../frontend/js/cid.js');
    const PLAN_CID = Cid.cidOfObject({ schema: 'plan/v1', title: 'Acacia Avenue' });
    const plan = { cid: PLAN_CID, content: { codes: [{ id: set.id, version: set.version }] } };
    const reference = { name: 'Acacia Avenue', osmWayIds: ['36', '12'], part: 'street', side: 'both' };
    const record = outcome => Eligibility.codeEvidence(set, outcome, { planCid: PLAN_CID, street: reference }, '2026-11-27T15:00:00.000Z');
    it('tells a building the code excludes from one that breaks it and one not known yet', async () => {
        const breaks = record(await run());
        expect(breaks.buildings).toEqual([{ design: 0, index: 0, factId: 'osm:way/36', kind: 'existing', verdict: 'breaks', failing: ['ssStoreys'], excluded: [], unknown: ['ssCeilingMin', 'ssSetbackCeiling'] }]);
        const listed = record(await run({ contract: contract({ heritage: { ...notListed, value: { listed: true, grade: 'II' } } }) }));
        expect(listed.buildings[0]).toMatchObject({ verdict: 'excluded', excluded: ['ssListed'], failing: ['ssStoreys'] });
        const unknown = record(await run({ street: null }));
        expect(unknown.buildings[0]).toMatchObject({ verdict: 'unknown', failing: [], excluded: [] });
        // The record keys the street it read by CID; its corner plots are not read, so they do not change it.
        expect(breaks.street).toBe(Eligibility.streetKey({ ...reference, osmWayIds: ['12', '36'], corners: [{ parcelId: 'p1', streets: ['Elm Road'] }] }));
        expect(Eligibility.normalizeCodeEvidence(breaks)).toEqual(breaks);
    });
    it('holds the vote on a building that breaks the code or that it excludes, never on an unknown one', async () => {
        const issues = (recorded, options = {}) => Eligibility.codeIssues(set, recorded, { plan, street: reference, ...options }).map(issue => issue.code);
        const breaks = record(await run());
        expect(Eligibility.codeIssues(set, breaks, { plan, street: reference })).toEqual([{ code: 'street-code-failed', buildings: breaks.buildings }]);
        expect(issues(record(await run({ contract: contract({ built: fact({ from: null, to: 1912 }) }), areas: [area('A', 130, areas[0].geometry)] })))).toEqual(['street-code-failed']);
        expect(issues(record(await run({ street: null })))).toEqual([]);
        expect(issues(record(await run({ areas: [area('A', 130, areas[0].geometry)] })))).toEqual([]);
        expect(issues(null)).toEqual(['street-code-missing']);
        // A check of another plan revision or another street is stale; a plan that does not claim the code is refused first.
        const passed = record(await run({ street: null }));
        expect(issues(passed, { plan: { ...plan, cid: Cid.cidOfObject({ other: true }) } })).toEqual(['street-code-stale']);
        expect(issues(passed, { street: null })).toEqual(['street-code-stale']);
        expect(issues(passed, { plan: { ...plan, content: {} } })).toEqual(['street-code-unclaimed']);
    });
    it('refuses a recorded verdict its own test lists do not support', async () => {
        const breaks = record(await run());
        const edit = change => ({ ...breaks, buildings: [{ ...breaks.buildings[0], ...change }] });
        expect(() => Eligibility.normalizeCodeEvidence(edit({ verdict: 'meets' }))).toThrow('malformed');
        expect(() => Eligibility.normalizeCodeEvidence(edit({ verdict: 'unknown', failing: [], excluded: ['ssStoreys'] }))).toThrow('malformed');
        expect(() => Eligibility.normalizeCodeEvidence(edit({ failing: ['ssNoSuchTest'] }))).toThrow('malformed');
        expect(() => Eligibility.normalizeCodeEvidence({ ...breaks, planCid: 'not-a-cid' })).toThrow('by CID');
        expect(() => Eligibility.normalizeCodeEvidence({ ...breaks, note: 'x' })).toThrow('malformed');
    });
});
