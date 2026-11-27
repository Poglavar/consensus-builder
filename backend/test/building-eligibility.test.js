// Building eligibility (frontend/js/planning/eligibility.js): Living Tradition's paragraph 17 tests
// from building facts, the houses a plan covers, and the check a street vote records.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const eligibility = require('../../frontend/js/planning/eligibility.js');

const set = eligibility.latest('gb-living-tradition-mansards');
const fact = (value, key = 'k') => ({ value, source: 'osm', key, raw: String(value) });
const georgian = { built: fact({ from: 1828, to: 1830 }), parapet: fact(true), storeys: fact(3), roof_shape: fact('flat'),
    footprint_m2: fact(45.6), row_size: fact(20), heritage: { value: { listed: false, grade: null, register: 'National Heritage List for England', reference: null, name: null, url: 'https://www.planning.data.gov.uk/dataset/listed-building', basis: 'none' }, source: 'gb-eng-nhle', key: 'listed-building', raw: 'no entry' } };
const listing = (grade, listed = true) => ({ value: { listed, grade, register: 'National Heritage List for England', reference: '1195683', name: 'NUMBERS 26 TO 50', url: 'https://historicengland.org.uk/listing/the-list/list-entry/1195683', basis: 'house-number' }, source: 'gb-eng-nhle', key: 'listed-building', raw: 'x' });
const statuses = result => Object.fromEntries(result.tests.map(test => [test.cite, test.status]));

describe('Living Tradition eligibility', () => {
    it('passes a parapeted Georgian terrace house, listing what it cannot check', () => {
        const result = eligibility.evaluate(set, georgian);
        expect(result.verdict).toBe('eligible');
        expect(statuses(result)).toEqual({ '17.1': 'pass', '17.2': 'pass', '17.3': 'unchecked', '17.4': 'pass', '17.5': 'pass',
            '17.6': 'pass', '17.7': 'pass', '17.8': 'unchecked', '17.9': 'pass', '17.10': 'unchecked' });
    });
    it('is unknown while a fact is, and never guesses one', () => {
        const result = eligibility.evaluate(set, { ...georgian, parapet: null, roof_shape: null, row_size: null });
        expect(result.verdict).toBe('unknown');
        expect(statuses(result)).toMatchObject({ '17.2': 'unknown', '17.4': 'unknown', '17.6': 'unknown' });
        expect(eligibility.evaluate(set, null).verdict).toBe('unknown');
    });
    it('fails each condition the facts break', () => {
        const cases = [[{ built: fact({ from: 1925, to: 1925 }) }, '17.1'], [{ parapet: fact(false) }, '17.2'], [{ roof_shape: fact('mansard') }, '17.4'],
            [{ storeys: fact(1) }, '17.5'], [{ row_size: fact(1) }, '17.6'], [{ footprint_m2: fact(140) }, '17.7']];
        for (const [change, cite] of cases) {
            const result = eligibility.evaluate(set, { ...georgian, ...change });
            expect(result.verdict, cite).toBe('ineligible');
            expect(statuses(result)[cite], cite).toBe('fail');
        }
        // A semi-detached pair passes 17.6.
        expect(statuses(eligibility.evaluate(set, { ...georgian, row_size: fact(2) }))['17.6']).toBe('pass');
    });
    it('judges 17.9 from the heritage register: Grade II passes, Grade I and II* fail with the grade, an unknown listing or grade is unknown', () => {
        const listingTest = heritage => eligibility.evaluate(set, { ...georgian, heritage }).tests.find(test => test.cite === '17.9');
        expect(listingTest(listing('II'))).toMatchObject({ status: 'pass', grade: 'II' });
        expect(listingTest(listing('II*'))).toMatchObject({ status: 'fail', grade: 'II*' });
        expect(listingTest(listing('I'))).toMatchObject({ status: 'fail', grade: 'I' });
        expect(eligibility.evaluate(set, { ...georgian, heritage: listing('II*') }).verdict).toBe('ineligible');
        // Listed, but the register states no grade (an outline without its entry): unknown, never a pass.
        expect(listingTest(listing(null)).status).toBe('unknown');
        // No register covers the place, or an entry on the row may cover the house: the fact is null.
        expect(listingTest(null).status).toBe('unknown');
        expect(eligibility.evaluate(set, { ...georgian, heritage: null }).verdict).toBe('unknown');
    });
    it('explains each failing or unknown test in the building card\'s words, with the register link, its reason or the key to add', () => {
        const t = (key, params = {}) => `${key}(${Object.values(params).join('|')})`;
        const edit = { url: 'https://www.openstreetmap.org/edit?editor=id&way=37', source: 'OpenStreetMap', keys: { parapet: 'building:parapet', storeys: 'building:levels' } };
        const entry = { reference: '1195683', name: 'NUMBERS 26 TO 50', grade: 'II', url: 'https://historicengland.org.uk/listing/the-list/list-entry/1195683' };
        const rowUncertain = { found: true, edit, facts: { ...georgian, parapet: null, heritage: null },
            unknown_reasons: { heritage: { code: 'row-uncertain', message: 'x', entries: [entry] } } };
        const explained = eligibility.explain(set, eligibility.evaluate(set, rowUncertain.facts), rowUncertain, t);
        expect(explained.map(test => test.cite)).toEqual(['17.2', '17.9']);
        expect(explained[0]).toMatchObject({ status: 'unknown', label: 'eligibility.test.parapet()', statusText: 'eligibility.status.unknown()', text: null,
            add: { key: 'building:parapet', source: 'OpenStreetMap', url: edit.url }, link: null });
        expect(explained[1]).toMatchObject({ status: 'unknown', reason: 'buildingFact.heritageUnknown.rowUncertain()', add: null,
            link: { url: entry.url, text: 'buildingFact.heritageEntry(1195683)' } });
        // A Grade II* listing fails with its grade and links its list entry.
        const starred = { found: true, edit, facts: { ...georgian, heritage: listing('II*') }, unknown_reasons: {} };
        const [fails] = eligibility.explain(set, eligibility.evaluate(set, starred.facts), starred, t);
        expect(fails).toMatchObject({ cite: '17.9', status: 'fail', statusText: 'eligibility.withGrade(eligibility.status.fail()|II*)',
            text: 'buildingFact.heritageListed(II*)', link: { url: entry.url } });
        // A failing OSM fact names its value; nothing to add.
        const flat = { found: true, edit, facts: { ...georgian, storeys: fact(1) }, unknown_reasons: {} };
        expect(eligibility.explain(set, eligibility.evaluate(set, flat.facts), flat, t)).toMatchObject([{ cite: '17.5', status: 'fail', text: '1', add: null }]);
    });
    it('reads dates as spans: "before 1913" passes, a span across 1918 is unknown', () => {
        const built = span => statuses(eligibility.evaluate(set, { ...georgian, built: fact(span) }))['17.1'];
        expect(built({ from: null, to: 1912 })).toBe('pass');
        expect(built({ from: 1910, to: 1929 })).toBe('unknown');
        expect(built({ from: 1918, to: null })).toBe('fail');
        expect(built({ from: 1650, to: 1690 })).toBe('fail');
    });
    it('applies where the city plans under English planning rules', () => {
        expect(eligibility.forCity(['gb-eng-planning']).map(rule => rule.id)).toEqual(['gb-living-tradition-mansards']);
        expect(eligibility.forCity(['hr-zagreb-gup'])).toEqual([]);
    });
});

describe('a street vote\'s eligibility check', () => {
    const raised = (sourceBuildingId, roof = 'mansard') => ({ type: 'Feature', geometry: null, properties: { basedOnExisting: true, sourceBuildingId, roof } });
    const designs = [{ geometry: { buildings: [raised('w36'), raised('w37'), raised('w38', 'pitched'), { properties: { type: 'proposedBuilding' } }] } },
        { geometry: { buildings: [raised('w36'), raised(4711)] } }];
    it('covers each existing building the plan raises with a mansard, once', () => {
        expect(eligibility.coveredHouses(set, designs)).toEqual([{ id: 'osm:way/36', sourceBuildingId: 'w36' }, { id: 'osm:way/37', sourceBuildingId: 'w37' },
            { id: null, sourceBuildingId: 4711 }]);
    });
    it('records each house\'s verdict and lets the vote start only when every covered house is eligible', async () => {
        const houses = eligibility.coveredHouses(set, designs).filter(house => house.id);
        const answers = new Map([['osm:way/36', { found: true, facts: georgian, source_version: { version: 5, changed: '2026-11-27T15:00:00Z' } }],
            ['osm:way/37', { found: true, facts: { ...georgian, parapet: null } }]]);
        const read = async ids => new Map(ids.map(id => [id, answers.get(id)]));
        const judged = await eligibility.check(set, houses, read);
        const recorded = eligibility.normalizeEvidence(eligibility.evidence(set, judged, '2026-11-27T15:01:00Z'));
        expect(recorded.houses).toEqual([{ id: 'osm:way/36', verdict: 'eligible', failing: [], unknown: [], sourceVersion: { version: 5, changed: '2026-11-27T15:00:00Z' } },
            { id: 'osm:way/37', verdict: 'unknown', failing: [], unknown: ['17.2'] }]);
        expect(eligibility.evidenceIssues(set, recorded, houses)).toEqual([{ code: 'eligibility-failed', houses: [recorded.houses[1]] }]);
        // The author tags No. 37's parapet and checks again.
        answers.set('osm:way/37', { found: true, facts: georgian });
        const again = eligibility.normalizeEvidence(eligibility.evidence(set, await eligibility.check(set, houses, read), '2026-11-27T15:05:00Z'));
        expect(eligibility.evidenceIssues(set, again, houses)).toEqual([]);
        // A plan revised to cover another house needs a new check; a raised building the facts do not answer never passes.
        expect(eligibility.evidenceIssues(set, again, [...houses, { id: 'osm:way/39' }])).toEqual([{ code: 'eligibility-stale' }]);
        const all = eligibility.coveredHouses(set, designs);
        const withUnknown = eligibility.evidence(set, await eligibility.check(set, all, read), '2026-11-27T15:06:00Z');
        expect(eligibility.evidenceIssues(set, eligibility.normalizeEvidence(withUnknown), all)[0].code).toBe('eligibility-failed');
        expect(eligibility.evidenceIssues(set, null, houses)).toEqual([{ code: 'eligibility-missing' }]);
        expect(eligibility.evidenceIssues(set, again, [])).toEqual([{ code: 'eligibility-no-houses' }]);
    });
    it('refuses a malformed recorded check', () => {
        const good = { set: { id: set.id, version: set.version }, checkedAt: '2026-11-27T15:00:00Z', houses: [{ id: 'osm:way/1', verdict: 'eligible', failing: [], unknown: [] }] };
        expect(() => eligibility.normalizeEvidence({ ...good, set: { id: 'other', version: '1' } })).toThrow('unknown rule set');
        expect(() => eligibility.normalizeEvidence({ ...good, houses: [{ ...good.houses[0], id: 'w1' }] })).toThrow('malformed');
        expect(() => eligibility.normalizeEvidence({ ...good, houses: [] })).toThrow('1–500');
    });
});
