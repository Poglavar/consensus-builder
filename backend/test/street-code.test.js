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
        expect(Eligibility.forCity(['gb-eng-planning'], { kind: 'street-code' }).map(s => s.id)).toEqual(['gb-strong-suburbs-street-code', 'gb-create-mews-block-code']);
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
    it('measures area-to-line distances exactly up to the asked cutoff, and only says "farther" beyond it', () => {
        // Brute force over every edge pair, against the box-pruned measure, on random squares and lines.
        let seed = 7;
        const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        const square = (x, y, s) => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]];
        const brute = (polygons, lines) => {
            let best = Infinity;
            for (const line of lines) for (let j = 0; j < line.length - 1; j++) for (const polygon of polygons) for (const ring of polygon)
                for (let i = 0; i < ring.length - 1; i++) {
                    const [a, b, p, q] = [line[j], line[j + 1], ring[i], ring[i + 1]];
                    const d = (pt, s0, s1) => { const dx = s1[0] - s0[0], dy = s1[1] - s0[1], l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((pt[0] - s0[0]) * dx + (pt[1] - s0[1]) * dy) / l)) : 0; return Math.hypot(pt[0] - s0[0] - t * dx, pt[1] - s0[1] - t * dy); };
                    const side = (o, u, v) => (u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0]);
                    const cross = side(a, b, p) * side(a, b, q) < 0 && side(p, q, a) * side(p, q, b) < 0;
                    best = Math.min(best, cross ? 0 : Math.min(d(a, p, q), d(b, p, q), d(p, a, b), d(q, a, b)));
                }
            return best;
        };
        for (let n = 0; n < 200; n++) {
            const polygons = [square(rand() * 400, rand() * 400, 20 + rand() * 80)];
            const lines = Array.from({ length: 3 }, () => [[rand() * 600, rand() * 600], [rand() * 600, rand() * 600], [rand() * 600, rand() * 600]]);
            const inside = lines.some(line => line.some(([x, y]) => x > polygons[0][0][0][0] && x < polygons[0][0][1][0] && y > polygons[0][0][0][1] && y < polygons[0][0][2][1]));
            const exact = inside ? 0 : brute(polygons, lines);
            expect(StreetCode.areaToLines(polygons, lines)).toBeCloseTo(exact, 6);
            for (const within of [0, 40, 200]) {
                const got = StreetCode.areaToLines(polygons, lines, within);
                if (exact <= within) expect(got).toBeCloseTo(exact, 6); else expect(got).toBeGreaterThan(within);
            }
        }
    });
    it('screens designations with one box around the buildings, then reads each building only when the box finds any', async () => {
        // A street's worth of outlines in one request was too long for the source (HTTP 414).
        const reads = [];
        const houses = Array.from({ length: 80 }, (_, i) => ({ ...house(), geometry: box(i * 10, 5, i * 10 + 6, 15) }));
        const check = found => StreetCode.check(set, { designs: [{ geometry: { buildings: houses } }], street,
            read: { density: async () => ({ areas, sources: [] }), facts: async () => contract({}), buildingsNear: async () => [],
                designations: async (geometry, datasets) => { reads.push(geometry); return reads.length === 1 ? found : []; } } });
        const clear = await check([]);
        expect(reads).toHaveLength(1);
        expect(reads[0].type).toBe('Polygon');
        expect(reads[0].coordinates[0]).toHaveLength(5);
        expect(statuses(clear.buildings[79].result).ssNature).toBe('pass');
        reads.length = 0;
        const near = await check(['site-of-special-scientific-interest']);
        expect(reads).toHaveLength(81);
        expect(statuses(near.buildings[0].result).ssNature).toBe('pass');
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
    // A row's houses, a single building and a parcel-based one are buildings like a block's: each is judged.
    it('judges the buildings of every typology, not only blocks', () => {
        const typed = type => ({ ...house(), properties: { ...house().properties, type } });
        const designs = [{ geometry: { buildings: ['proposedBuilding', 'proposedRowHouse', 'proposedBuildingSingle', 'proposedParcelBasedBuilding'].map(typed) } }];
        expect(StreetCode.planBuildings(designs)).toHaveLength(4);
        expect(StreetCode.planBuildings([{ geometry: { buildings: [typed('tree')] } }])).toHaveLength(0);
    });
    it('explains a failing derived fact with the cap and the area it came from', async () => {
        const outcome = await run();
        const t = (key, params = {}) => `${key}(${Object.values(params).join('|')})`;
        const [row] = StreetCode.describe(set, outcome, t)[0].tests;
        expect(row).toMatchObject({ cite: '30', status: 'fail', text: 'eligibility.fact.proposedStoreys(3) · eligibility.fact.storeyCap(2|15|B)' });
        // Paras 35 and 52 are light planes the check reads (light-planes.js), no longer listed as unchecked.
        expect(StreetCode.unchecked(set).map(test => test.cite)).toEqual(['14', '36.2', '39', '41', '42', '51']);
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
        expect(breaks.buildings).toEqual([{ design: 0, index: 0, factId: 'osm:way/36', kind: 'existing', verdict: 'breaks', failing: ['ssStoreys'], excluded: [], unknown: ['ssLightPlanes', 'ssCeilingMin', 'ssSetbackCeiling', 'ssDetached'] }]);
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

// Light planes in a street code (light-planes.js through street-code.js planeFacts): Create Mews' block
// plan code (2022) on a block of four plots with a mews in the back gardens, and Strong Suburbs' paras
// 35 and 52, with the protected plots' owners named where a plane is pierced, which they may waive.
describe('light planes in a street code', () => {
    const mews = Eligibility.get('gb-create-mews-block-code', '2022');
    const plot = (id, w, s, e, n) => ({ id, geometry: box(w, s, e, n) });
    // A block 48 m wide and 80 m deep, streets all round: two plots on the south street (y 0–40), two on the north.
    const blockPlots = [plot('A', 0, 0, 24, 40), plot('B', 24, 0, 48, 40), plot('C', 0, 40, 24, 80), plot('D', 24, 40, 48, 80)];
    const block = { parcelSourceId: 'test', parcelIds: ['A', 'B', 'C', 'D'] };
    const houses = [['h1', 4, 2, 20, 12, 9], ['h2', 28, 2, 44, 12, 9], ['h3', 4, 68, 20, 78, 9], ['h4', 28, 68, 44, 78, 9]]
        .map(([id, w, s, e, n, height]) => ({ id: `w${id.slice(1)}`, geometry: box(w, s, e, n), height }));
    // A 5 m cottage on plot A: 14 m from the west street (20° plane 5.1 m), 6 m from B (40°: 5.03 m), 8 m from C.
    const cottage = (props = {}, at = [14, 26, 18, 32]) => ({ type: 'Feature', geometry: box(...at),
        properties: { type: 'proposedBuilding', height: 5, floors: 2, floorHeightM: 2.5, roof: null, ...props } });
    const factsOf = (heights = true) => async ids => new Map(ids.map(id => [id, { found: true, facts: { height_m: heights ? fact(houses.find(h => `osm:way/${h.id.slice(1)}` === id)?.height ?? null) : null } }]));
    const runMews = (options = {}) => StreetCode.check(mews, { designs: [{ geometry: { buildings: options.buildings || [cottage()] } }], street: null, block: 'block' in options ? options.block : block,
        read: { plots: async query => (query.parcelIds ? blockPlots.filter(p => query.parcelIds.includes(p.id)) : blockPlots), buildingsNear: async () => houses.map(h => ({ type: 'Feature', id: h.id, geometry: h.geometry, properties: {} })),
            facts: options.facts || factsOf(), designations: async () => [] } });

    it('passes a two-storey mews cottage in the back gardens under every plane, as no building breaks it', async () => {
        const outcome = await runMews();
        const result = outcome.buildings[0].result;
        expect(statuses(result)).toMatchObject({ cmStreetPlane: 'pass', cmPlotPlane: 'pass', cmPrivacyPlane: 'pass', cmTallest: 'pass', cmBlockSize: 'unchecked' });
        // Only its ceilings stay unknown (the design states storey heights, not ceilings, para 28).
        expect(Eligibility.codeVerdict(mews, result)).toBe('unknown');
        expect(result.tests.filter(test => test.status === 'unknown').map(test => test.id)).toEqual(['cmCeilingMin']);
        // A 2.4 m storey is under 2.5 m floor to floor, so it breaks para 28 for certain.
        const low = (await runMews({ buildings: [cottage({ floorHeightM: 2.4, height: 4.8 })] })).buildings[0].result;
        expect(statuses(low).cmCeilingMin).toBe('fail');
        expect(Eligibility.codeVerdict(mews, low)).toBe('breaks');
    });
    it('names the plots whose owners may waive the 70° and 40° planes a cottage on the boundary pierces (26e, 26f)', async () => {
        // On plot A, against plot B's boundary at x = 24: the 70° plane is 0 m high there.
        const outcome = await runMews({ buildings: [cottage({}, [18, 26, 24, 32])] });
        const result = outcome.buildings[0].result;
        expect(statuses(result)).toMatchObject({ cmPlotPlane: 'fail', cmPrivacyPlane: 'fail', cmStreetPlane: 'pass' });
        expect(result.tests.find(test => test.id === 'cmPlotPlane').parcels).toEqual(['B']);
        expect(Eligibility.codeVerdict(mews, result)).toBe('waivable');
        expect(Eligibility.waiverPlots(mews, result).map(row => [row.cite, row.parcels])).toEqual([['26e', ['B']], ['26f', ['B']]]);
        // A waivable building does not hold the vote back.
        const recorded = Eligibility.codeEvidence(mews, outcome, { planCid: Eligibility.blockKey(block), block }, '2026-11-27T12:00:00.000Z');
        expect(recorded.buildings[0].verdict).toBe('waivable');
        expect(Eligibility.normalizeCodeEvidence(recorded)).toEqual(recorded);
    });
    it('leaves the 20° street plane unknown while a building between could raise it (26a), and caps height 9 m over the tallest (26h)', async () => {
        // 13 m tall, 14 m from the west street: over its 20° line (5.1 m) whatever stands in between,
        // so with the houses' heights known it breaks the code; with one unknown it is not known yet.
        const tall = [cottage({ height: 13, floors: 5, floorHeightM: 2.6 }, [14, 16, 18, 20])];
        expect(statuses((await runMews({ buildings: tall })).buildings[0].result)).toMatchObject({ cmStreetPlane: 'fail', cmTallest: 'pass' });
        expect(statuses((await runMews({ buildings: tall, facts: factsOf(false) })).buildings[0].result)).toMatchObject({ cmStreetPlane: 'unknown', cmTallest: 'unknown' });
        const tower = [cottage({ height: 19, floors: 6, floorHeightM: 3.1 })];
        expect(statuses((await runMews({ buildings: tower })).buildings[0].result)).toMatchObject({ cmTallest: 'fail' });
        expect(statuses((await runMews({ block: null })).buildings[0].result)).toMatchObject({ cmStreetPlane: 'unknown', cmPlotPlane: 'unknown', cmTallest: 'unknown' });
    });
    it('keys a block vote\'s check by its plots, so another block is stale', async () => {
        const plan = { cid: Eligibility.blockKey(block), content: { codes: [{ id: mews.id, version: mews.version }] } };
        const recorded = Eligibility.codeEvidence(mews, await runMews(), { planCid: plan.cid, block }, '2026-11-27T12:00:00.000Z');
        expect(Eligibility.codeIssues(mews, recorded, { plan, block: { ...block, parcelIds: ['D', 'C', 'B', 'A'] } })).toEqual([]);
        expect(Eligibility.codeIssues(mews, recorded, { plan, block: { ...block, parcelIds: ['A', 'B'] } }).map(issue => issue.code)).toEqual(['street-code-stale']);
    });
    it('reads Strong Suburbs para 52 only against a neighbour not attached, and para 35 only against plots off the voted street', async () => {
        // The house of `house()` (30–36 east, 5–15 north) on plot P, a detached neighbour on Q to the east.
        // Plots front the street 4 m from its centre line; R behind P fronts another street.
        const plots = [plot('P', 26, 4, 38, 30), plot('Q', 38, 4, 50, 30), plot('R', 26, 30, 38, 60)];
        const near = [{ type: 'Feature', id: 'w36', geometry: box(30, 5, 36, 15), properties: {} }, { type: 'Feature', id: 'w40', geometry: box(42, 5, 48, 15), properties: {} }];
        const raised = house({ height: 9, floorHeightM: 3, existingHeight: 6, roof: null, geometry: undefined });
        const runSs = (building, extra = {}) => StreetCode.check(set, { designs: [{ geometry: { buildings: [building] } }], street,
            read: { density: async () => ({ areas, sources: [] }), facts: async () => contract({}), designations: async () => [], buildingsNear: async () => near, plots: async () => plots, ...extra } });
        const outcome = await runSs({ ...raised, geometry: box(30, 5, 38, 25) });
        const result = outcome.buildings[0].result;
        // Built to Q's boundary and 5 m from R's, raised from 6 m to 9 m: over 70° from Q (detached),
        // and over 35° from R, a plot off the street (Q, on the street, is no para 35 neighbour).
        expect(statuses(result)).toMatchObject({ ssDetached: 'fail', ssLightPlanes: 'fail' });
        expect(result.tests.find(test => test.id === 'ssDetached').parcels).toEqual(['Q']);
        expect(result.tests.find(test => test.id === 'ssLightPlanes').parcels).toEqual(['R']);
        // Attached to the house on Q, para 52 does not protect Q.
        const attached = await runSs({ ...raised, geometry: box(30, 5, 38, 25) }, { buildingsNear: async () => [near[0], { ...near[1], geometry: box(38, 5, 48, 15) }] });
        expect(statuses(attached.buildings[0].result).ssDetached).toBe('pass');
        // Its kept volume (6 m) is never judged: a raise that stays under the planes passes.
        const low = await runSs({ ...raised, properties: { ...raised.properties, height: 6.5 }, geometry: box(30, 5, 34, 15) });
        expect(statuses(low.buildings[0].result)).toMatchObject({ ssDetached: 'pass', ssLightPlanes: 'pass' });
    });
    // Alone it takes ~165 ms in ~19 slices of at most ~16 ms; the bound is loose so a busy machine (other
    // test files in parallel) does not fail it, while a check that ran a whole street in one go would.
    it('checks a street of 77 houses in slices that hand back the thread', async () => {
        const row = Array.from({ length: 77 }, (_, i) => ({ type: 'Feature', geometry: box(i * 8, 5, i * 8 + 7, 15),
            properties: { type: 'proposedBuilding', basedOnExisting: true, sourceBuildingId: `w${1000 + i}`, height: 7, floors: 2, floorHeightM: 3.5, existingHeight: 6, roof: 'mansard' } }));
        const lots = row.map((_, i) => plot(`L${i}`, i * 8, 0, i * 8 + 8, 30)).concat(row.map((_, i) => plot(`M${i}`, i * 8, 30, i * 8 + 8, 60)));
        const longStreet = [[at(0, 0), at(620, 0)]];
        const slicer = require('../../frontend/js/work-slicer.js').createSlicer({ budgetMs: 8, yieldNow: () => new Promise(resolve => setImmediate(resolve)) });
        const started = performance.now();
        const outcome = await StreetCode.check(set, { designs: [{ geometry: { buildings: row } }], street: longStreet, slicer,
            read: { density: async () => ({ areas, sources: [] }), facts: async () => new Map(), designations: async () => [], buildingsNear: async () => [], plots: async () => lots } });
        const totalMs = performance.now() - started;
        console.log(`[street-code] 77 houses: ${Math.round(totalMs)} ms total, ${slicer.pauses} yields, longest slice ${Math.round(slicer.longestSliceMs)} ms`);
        expect(outcome.buildings).toHaveLength(77);
        expect(slicer.pauses).toBeGreaterThan(0);
        expect(slicer.pauses).toBeGreaterThan(5);
        expect(slicer.longestSliceMs).toBeLessThan(250);
    }, 60000);
});
