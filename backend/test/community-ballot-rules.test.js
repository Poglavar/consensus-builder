// Street-vote ballot rules: shipped versions stay pinned, thresholds are exact fractions, households
// count by the published partition, and the voting record validates households and the rule.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Rules = require('../../frontend/js/community/ballot-rules.js');
const V = require('../../frontend/js/community/voting.js');

const h = i => i.toString(16).padStart(64, '0');
const ID = '0b6f6a52-2f43-4c3e-9a51-0c0d6b1e2f11';
const SS = Rules.get('gb-street-vote-strong-suburbs', '2026-11-25');
const GC = Rules.get('gb-street-vote-consultation-2023', '2026-11-25');
// Ten residents in four households: [1,2,3], [4,5], [6,7,8], [9,10].
const config = V.configuration({ schema: 'community-voting/v2', id: ID, codeHashes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(h),
    households: [[1, 2, 3], [4, 5], [6, 7, 8], [9, 10]].map(group => group.map(h)), rule: { id: SS.id, version: SS.version } });
const ballots = entries => entries.map(([code, choice]) => ({ codeHash: h(code), choice }));
const byMeasure = result => Object.fromEntries(result.tests.map(test => [test.measure, test]));

describe('shipped ballot rules', () => {
    it('lists every shipped version with its thresholds and source; versions are never edited', () => {
        // A published agreement pins id@version: changing a shipped entry rewrites rules people voted under.
        expect(Rules.RULES.map(rule => ({ key: `${rule.id}@${rule.version}`, tests: rule.tests, sources: rule.sources.map(source => source.url) }))).toEqual([
            { key: 'gb-street-vote-strong-suburbs@2026-11-25', tests: [
                { measure: 'cast-support', numerator: 3, denominator: 5, strict: false },
                { measure: 'household-turnout', numerator: 1, denominator: 2, strict: false },
                { measure: 'household-support', numerator: 1, denominator: 2, strict: false }],
            sources: ['https://policyexchange.org.uk/wp-content/uploads/2022/10/Strong-Suburbs.pdf'] },
            { key: 'gb-street-vote-strong-suburbs@2026-11-27', tests: [
                { measure: 'cast-support', numerator: 3, denominator: 5, strict: false },
                { measure: 'household-turnout', numerator: 1, denominator: 2, strict: false },
                { measure: 'household-support', numerator: 1, denominator: 2, strict: false }],
            sources: ['https://policyexchange.org.uk/wp-content/uploads/2022/10/Strong-Suburbs.pdf'] },
            { key: 'gb-street-vote-consultation-2023@2026-11-25', tests: [
                { measure: 'eligible-support', numerator: 3, denominator: 5, strict: false },
                { measure: 'household-support', numerator: 1, denominator: 2, strict: false }],
            sources: ['https://www.gov.uk/government/consultations/street-vote-development-orders-consultation/street-vote-development-orders'] },
            { key: 'gb-street-vote-living-tradition@2026-11-27', tests: [
                { measure: 'cast-support', numerator: 1, denominator: 2, strict: false },
                { measure: 'household-turnout', numerator: 1, denominator: 2, strict: false },
                { measure: 'household-support', numerator: 1, denominator: 2, strict: false }],
            sources: ['https://www.createstreets.com/wp-content/uploads/2025/07/Living-Tradition.pdf'] },
            { key: 'gb-block-vote-create-mews@2026-11-27', tests: [
                { measure: 'eligible-support', numerator: 2, denominator: 3, strict: false },
                { measure: 'household-eligible-support', numerator: 1, denominator: 2, strict: false },
                { measure: 'long-resident-support', numerator: 1, denominator: 2, strict: false }],
            sources: ['https://www.createstreets.com/wp-content/uploads/2022/02/Create-Mews.pdf'] }
        ]);
        // A new vote chooses the newest version of each rule; the 2026-11-25 Strong Suburbs version
        // stays readable for the records that pinned it.
        expect(Rules.list().map(rule => `${rule.id}@${rule.version}`)).toEqual(['gb-street-vote-strong-suburbs@2026-11-27',
            'gb-street-vote-consultation-2023@2026-11-25', 'gb-street-vote-living-tradition@2026-11-27', 'gb-block-vote-create-mews@2026-11-27']);
        expect(Rules.get('gb-street-vote-strong-suburbs', '2026-11-25')).toBe(SS);
        // Para 2: the 2026-11-27 version is held only on a plan that complies with the Strong Suburbs street code.
        expect(Rules.latest('gb-street-vote-strong-suburbs').requires).toEqual({ streetCode: { id: 'gb-strong-suburbs-street-code', version: '2021' } });
        expect(SS.requires).toBeUndefined();
        for (const rule of Rules.RULES) rule.tests.forEach(test => expect(Rules.MEASURES).toContain(test.measure));
    });
});

describe('evaluate', () => {
    it('passes Strong Suburbs at exactly 60% of votes cast with half the households voting and supporting', () => {
        // Households 1 and 2 vote (2 of 4 = half); 3 of 5 votes support; both voting households have a yes.
        const result = Rules.evaluate(SS, config, ballots([[1, 'support'], [2, 'support'], [3, 'oppose'], [4, 'support'], [5, 'abstain']]));
        expect(result.households).toEqual({ eligible: 4, voted: 2, supporting: 2 });
        expect(byMeasure(result)).toMatchObject({
            'cast-support': { count: 3, total: 5, needed: 3, met: true },
            'household-turnout': { count: 2, total: 4, needed: 2, met: true },
            'household-support': { count: 2, total: 2, needed: 1, met: true } });
        expect(result.passed).toBe(true);
    });

    it('fails just under 60% of votes cast, and counts an abstention as a vote cast', () => {
        const result = Rules.evaluate(SS, config, ballots([[1, 'support'], [2, 'support'], [3, 'oppose'], [4, 'support'], [5, 'abstain'], [6, 'abstain']]));
        expect(byMeasure(result)['cast-support']).toMatchObject({ count: 3, total: 6, needed: 4, met: false });
        expect(result.passed).toBe(false);
    });

    it('needs half the voting households to have a yes, however large one supporting household is', () => {
        // Household [6,7,8] all support (3 of 5 votes); households [1,2,3] and [4,5] vote no: 1 of 3 voting households.
        const result = Rules.evaluate(SS, config, ballots([[6, 'support'], [7, 'support'], [8, 'support'], [1, 'oppose'], [4, 'oppose']]));
        expect(byMeasure(result)['household-support']).toMatchObject({ count: 1, total: 3, needed: 2, met: false });
        expect(byMeasure(result)['cast-support'].met).toBe(true);
        expect(result.passed).toBe(false);
    });

    it('measures the 2023 consultation rule against every eligible voter, not votes cast', () => {
        const unanimousFew = ballots([[1, 'support'], [4, 'support'], [6, 'support'], [9, 'support'], [2, 'support']]);
        expect(byMeasure(Rules.evaluate(GC, config, unanimousFew))['eligible-support']).toMatchObject({ count: 5, total: 10, needed: 6, met: false });
        const enough = Rules.evaluate(GC, config, ballots([[1, 'support'], [2, 'support'], [4, 'support'], [6, 'support'], [7, 'support'], [9, 'support']]));
        expect(enough.passed).toBe(true);
    });

    it('meets no test before anyone votes, and without households each code is its own household', () => {
        expect(Rules.evaluate(SS, config, []).tests.every(test => test.met === false)).toBe(true);
        const flat = V.configuration({ schema: 'community-voting/v2', id: ID, codeHashes: [1, 2, 3].map(h) });
        expect(Rules.evaluate(null, flat, ballots([[1, 'support'], [2, 'oppose']]))).toEqual({ households: { eligible: 3, voted: 2, supporting: 1 }, tests: [], passed: null });
        // A ballot for a code outside the list is not counted.
        expect(Rules.evaluate(null, flat, ballots([[99, 'support']])).households.voted).toBe(0);
    });
});

describe('voting record v2', () => {
    it('canonicalizes households and drops a list of one-code households', () => {
        const shuffled = V.configuration({ schema: 'community-voting/v2', id: ID, codeHashes: [3, 1, 2].map(h), households: [[h(3), h(1)], [h(2)]] });
        expect(shuffled.households).toEqual([[h(1), h(3)], [h(2)]]);
        expect(V.configuration({ schema: 'community-voting/v2', id: ID, codeHashes: [1, 2].map(h), households: [[h(2)], [h(1)]] })).toEqual({ schema: 'community-voting/v2', id: ID, codeHashes: [h(1), h(2)] });
    });

    it('refuses households that miss, repeat or add a code, and unknown rules or fields', () => {
        const base = { schema: 'community-voting/v2', id: ID, codeHashes: [1, 2].map(h) };
        expect(() => V.configuration({ ...base, households: [[h(1)]] })).toThrow(/every eligible code/);
        expect(() => V.configuration({ ...base, households: [[h(1), h(2)], [h(2)]] })).toThrow(/every eligible code/);
        expect(() => V.configuration({ ...base, households: [[h(1), h(3)], [h(2)]] })).toThrow(/every eligible code/);
        expect(() => V.configuration({ ...base, households: [[h(1)], []] })).toThrow(/every eligible code/);
        expect(() => V.configuration({ ...base, rule: { id: SS.id, version: '2020-01-01' } })).toThrow(/ballot rule/);
        expect(() => V.configuration({ ...base, rule: { id: SS.id, version: SS.version, note: 'x' } })).toThrow(/ballot rule/);
        expect(() => V.configuration({ ...base, labels: ['Person'] })).toThrow();
        // Published v1 records keep validating, with their exact v1 keys only.
        expect(V.configuration({ schema: 'community-voting/v1', id: ID, codeHashes: [h(2), h(1)] })).toEqual({ schema: 'community-voting/v1', id: ID, codeHashes: [h(1), h(2)] });
        expect(() => V.configuration({ schema: 'community-voting/v1', id: ID, codeHashes: [h(1)], rule: { id: SS.id, version: SS.version } })).toThrow();
    });

    it('keeps a street code check only under a rule that requires that code, in its canonical form', () => {
        const Cid = require('../../frontend/js/cid.js');
        const SS2 = Rules.latest('gb-street-vote-strong-suburbs');
        const check = { set: { id: 'gb-strong-suburbs-street-code', version: '2021' }, checkedAt: '2026-11-27T15:00:00Z', planCid: Cid.cidOfObject({ plan: 1 }), street: null,
            buildings: [{ design: 0, index: 0, factId: null, kind: 'new', verdict: 'unknown', failing: [], excluded: [], unknown: ['ssStoreys'] }] };
        const base = { schema: 'community-voting/v2', id: ID, codeHashes: [1, 2].map(h) };
        expect(V.configuration({ ...base, rule: { id: SS2.id, version: SS2.version }, streetCode: check }).streetCode)
            .toEqual({ ...check, checkedAt: '2026-11-27T15:00:00.000Z' });
        expect(() => V.configuration({ ...base, rule: { id: SS.id, version: SS.version }, streetCode: check })).toThrow('requires a street code');
        expect(() => V.configuration({ ...base, streetCode: check })).toThrow('requires a street code');
        expect(() => V.configuration({ ...base, rule: { id: SS2.id, version: SS2.version }, streetCode: { ...check, set: { id: 'gb-living-tradition-mansards', version: '2026-11-27' } } })).toThrow('unknown street code');
    });

    it('derives households from local labels and reads resident CSVs and saved files with households', async () => {
        expect(V.householdsOf([{ codeHash: h(1), household: '12 Acacia Avenue' }, { codeHash: h(2), household: '' }, { codeHash: h(3), household: ' 12 Acacia Avenue ' }]))
            .toEqual([[h(1), h(3)], [h(2)]]);
        expect(V.residentsCsv('﻿Person,Household\r\n"Smith, Jo",12 Acacia Avenue\r\n\'=Ann,14\r\n')).toEqual([
            { label: 'Smith, Jo', household: '12 Acacia Avenue' }, { label: '=Ann', household: '14' }]);
        expect(V.residentsCsv('Household;Person\n3;Bo\n')).toEqual([{ label: 'Bo', household: '3' }]);
        expect(() => V.residentsCsv('Name,Code\nA,B\n')).toThrow(/Person and Household/);
        const [row] = await V.generateEntries(ID, [{ label: 'Jo', household: '12' }]);
        expect(V.distributionCsv([row])).toBe(`Person,Household,Code\r\n"Jo","12","${row.code}"`);
        expect((await V.importLocalFile(V.localFile(ID, [row]))).entries).toEqual([row]);
    });
});

// Create Mews' block vote (paras 4–6): two-thirds of all eligible voters, a yes in half of all the
// households, half of the residents of three years or more; twenty households; held on a block.
describe('Create Mews block vote', () => {
    const CM = Rules.get('gb-block-vote-create-mews', '2026-11-27');
    const block = { parcelSourceId: 'gb-hmlr-browser-v1', parcelIds: ['p2', 'p1'] };
    // 40 residents in 20 households of two; residents 1–10 have lived there three years or more.
    const codes = Array.from({ length: 40 }, (_, i) => h(i + 1));
    const households = Array.from({ length: 20 }, (_, i) => [codes[2 * i], codes[2 * i + 1]]);
    const record = (extra = {}) => ({ schema: 'community-voting/v2', id: ID, codeHashes: codes, households, longResidents: codes.slice(0, 10), rule: { id: CM.id, version: CM.version }, block, ...extra });
    it('records the block and the long residents, and refuses a vote without them or under twenty households', () => {
        const config = V.configuration(record());
        expect(config.block).toEqual({ parcelSourceId: 'gb-hmlr-browser-v1', parcelIds: ['p1', 'p2'] });
        expect(config.longResidents).toEqual(codes.slice(0, 10).sort());
        expect(CM.requires).toEqual({ streetCode: { id: 'gb-create-mews-block-code', version: '2022' } });
        expect(V.ruleIssues(config)).toEqual([]);
        // The record can be built up step by step; what the rule still lacks is an issue at saving.
        expect(V.ruleIssues(V.configuration(record({ block: undefined })))).toEqual([{ code: 'block-missing' }]);
        expect(V.ruleIssues(V.configuration(record({ longResidents: undefined })))).toEqual([{ code: 'long-residents-missing', years: 3 }]);
        expect(() => V.configuration(record({ longResidents: [h(99)] }))).toThrow('Long residents');
        const few = codes.slice(0, 38);
        expect(V.ruleIssues(V.configuration(record({ codeHashes: few, households: Array.from({ length: 19 }, (_, i) => [few[2 * i], few[2 * i + 1]]), longResidents: few.slice(0, 10) }))))
            .toEqual([{ code: 'households-too-few', min: 20, households: 19 }]);
        expect(() => V.configuration(record({ block: { parcelSourceId: 's', parcelIds: ['a', 'a'] } }))).toThrow('distinct parcel ids');
    });
    it('counts two-thirds of all eligible voters, a yes in half of all households and half the long residents', () => {
        const config = V.configuration(record());
        // 27 of 40 support (≥ 2/3 needs 27), spread so 14 of 20 households have a yes; 5 of 10 long residents.
        const yes = [...codes.slice(0, 5), ...codes.slice(10, 32)];
        const result = Rules.evaluate(CM, config, yes.map(codeHash => ({ codeHash, choice: 'support' })));
        expect(byMeasure(result)).toMatchObject({
            'eligible-support': { count: 27, total: 40, needed: 27, met: true },
            'household-eligible-support': { count: 14, total: 20, met: true },
            'long-resident-support': { count: 5, total: 10, met: true } });
        expect(result.passed).toBe(true);
        const fewer = Rules.evaluate(CM, config, yes.slice(1).map(codeHash => ({ codeHash, choice: 'support' })));
        expect(byMeasure(fewer)['long-resident-support'].met).toBe(false);
        expect(fewer.passed).toBe(false);
    });
    it('reads an optional Years column, and keeps years in the local list, never in the record', async () => {
        const rows = V.residentsCsv('Person,Household,Years\r\nAda,1 Mews Row,4\r\nBen,1 Mews Row,\r\nCy,2 Mews Row,2');
        expect(rows.map(row => row.years)).toEqual([4, null, 2]);
        expect(() => V.residentsCsv('Person,Household,Years\r\nAda,1,four')).toThrow('whole number');
        const entries = await V.generateEntries(ID, rows, globalThis.crypto);
        expect(V.longResidentsOf(entries, 3)).toEqual([entries[0].codeHash]);
        expect(V.localFile(ID, entries).entries.map(row => row.years ?? null)).toEqual([4, null, 2]);
        const back = await V.importLocalFile(V.localFile(ID, entries));
        expect(back.entries.map(row => row.years)).toEqual([4, null, 2]);
        expect(V.distributionCsv(entries).split('\r\n')[0]).toBe('Person,Household,Years,Code');
    }, 30000);
});
