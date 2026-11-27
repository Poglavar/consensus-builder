// Building eligibility: whether an existing building meets a rule set's conditions on what it is —
// its age, form and stated facts — test by test. Rules are data; each test reads one building fact
// from the shared API's building-facts contract (buildings/building-facts.js), so the browser and
// the agents' server judge a building alike. A test is unknown while its fact is, and a condition no
// source states yet is listed as unchecked, never assumed. A plan's covered houses and the evidence
// a street vote records are derived here too (community/ballot-rules.js `requires`).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BuildingEligibility = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const factsApi = () => (root && root.BuildingFacts) || require('../buildings/building-facts.js');

    // A rule set is dated like a ballot rule: a published vote pins id@version, so a shipped version
    // is never edited; a re-check adds a new entry. English text is the fallback for the
    // `planningViews.eligibility.*` i18n keys.
    const RULE_SETS = [{
        id: 'gb-living-tradition-mansards', version: '2026-11-27', planningRuleSet: 'gb-eng-planning',
        // The houses a plan covers: existing buildings it raises with this roof.
        covers: { roof: 'mansard' },
        source: { label: 'Samuel Hughes, Living Tradition (Create Streets, August 2021), para. 17', url: 'https://www.createstreets.com/wp-content/uploads/2025/07/Living-Tradition.pdf' },
        text: { name: 'Mansard eligibility' },
        tests: [
            // "Built after 1700 and before 1918". A date known only as "before 1913" passes: the 1700
            // bound keeps out pre-Georgian buildings, and a terrace that old would be dated.
            { id: 'built', cite: '17.1', check: 'builtBetween', after: 1700, before: 1918, openStartPasses: true },
            { id: 'parapet', cite: '17.2', check: 'factIs', fact: 'parapet', value: true },
            { id: 'frontGable', cite: '17.3', check: 'unchecked' },
            { id: 'noMansard', cite: '17.4', check: 'factIsNot', fact: 'roof_shape', value: 'mansard' },
            { id: 'storeys', cite: '17.5', check: 'factAtLeast', fact: 'storeys', min: 2 },
            // A terrace of at least three, or a semi-detached pair (17.6: a pair adds mansards together).
            { id: 'attached', cite: '17.6', check: 'row', fact: 'row_size', minRow: 3, pairPasses: true },
            { id: 'footprint', cite: '17.7', check: 'factAtMost', fact: 'footprint_m2', max: 100 },
            { id: 'originalUse', cite: '17.8', check: 'unchecked' },
            { id: 'listing', cite: '17.9', check: 'unchecked' },
            { id: 'topWindows', cite: '17.10', check: 'unchecked' },
        ],
    }];
    const byKey = new Map(RULE_SETS.map(set => [`${set.id}@${set.version}`, set]));
    const get = (id, version) => byKey.get(`${id}@${version}`) || null;
    const latest = id => RULE_SETS.filter(set => set.id === id).sort((a, b) => (a.version < b.version ? 1 : -1))[0] || null;
    // The newest version of each set that applies under a city's planning rule sets.
    function forCity(planningRuleSetIds = []) {
        return RULE_SETS.filter(set => latest(set.id) === set && planningRuleSetIds.includes(set.planningRuleSet));
    }

    const valueOf = (facts, name) => (facts && facts[name] ? facts[name].value : null);

    // One test → { id, cite, status: pass | fail | unknown | unchecked, value }.
    function runTest(test, facts) {
        const result = (status, value) => ({ id: test.id, cite: test.cite, status, ...(value === undefined ? {} : { value }) });
        const value = test.fact ? valueOf(facts, test.fact) : null;
        switch (test.check) {
            case 'builtBetween': {
                const span = valueOf(facts, 'built');
                if (!span) return result('unknown');
                const { from, to } = span;
                if ((finite(from) && from >= test.before) || (finite(to) && to <= test.after)) return result('fail', span);
                // An open start ("before 1913") passes the lower bound only where the set says so.
                const afterKept = finite(from) ? from > test.after : test.openStartPasses === true;
                return result(finite(to) && to < test.before && afterKept ? 'pass' : 'unknown', span);
            }
            case 'factIs': return value === null ? result('unknown') : result(value === test.value ? 'pass' : 'fail', value);
            case 'factIsNot': return value === null ? result('unknown') : result(value === test.value ? 'fail' : 'pass', value);
            case 'factAtLeast': return !finite(value) ? result('unknown') : result(value >= test.min ? 'pass' : 'fail', value);
            case 'factAtMost': return !finite(value) ? result('unknown') : result(value <= test.max ? 'pass' : 'fail', value);
            case 'row': return !finite(value) ? result('unknown')
                : result(value >= test.minRow || (test.pairPasses && value === 2) ? 'pass' : 'fail', value);
            default: return result('unchecked');
        }
    }

    // A building's facts under a rule set → each test's result and the verdict: ineligible when a
    // test fails, unknown while one is unknown, else eligible (with the unchecked ones beside it).
    function evaluate(set, facts) {
        const tests = set.tests.map(test => runTest(test, facts));
        const has = status => tests.some(test => test.status === status);
        return { set: { id: set.id, version: set.version }, verdict: has('fail') ? 'ineligible' : has('unknown') ? 'unknown' : 'eligible', tests };
    }

    // The houses a plan covers under a set: each existing building its designs raise with the set's
    // roof, by the building-facts id of its source building. A raised building the facts contract
    // does not answer is listed with a null id, so it can never pass.
    function coveredHouses(set, designs) {
        const houses = new Map();
        for (const design of designs || []) {
            for (const building of design?.geometry?.buildings || []) {
                const p = building?.properties || {};
                if (p.basedOnExisting !== true || p.roof !== set.covers.roof) continue;
                const id = factsApi().factIdOf({ properties: { id: p.sourceBuildingId } }, p.sourceBuildingId);
                const key = id || `unknown:${p.sourceBuildingId ?? houses.size}`;
                if (!houses.has(key)) houses.set(key, { id, sourceBuildingId: p.sourceBuildingId ?? null });
            }
        }
        return [...houses.values()];
    }

    // Read the covered houses' facts (read: ids → Map id → contract building) and judge each one.
    async function check(set, houses, read) {
        const ids = houses.map(house => house.id).filter(Boolean);
        const answers = ids.length ? await read(ids) : new Map();
        return houses.map(house => {
            const building = house.id ? answers.get(house.id) || null : null;
            const result = evaluate(set, building?.found ? building.facts : null);
            return { ...house, building, result, sourceVersion: building?.source_version || null };
        });
    }

    // What a street vote records of its check: the set, when, and each house's verdict with the tests
    // it failed or could not decide and the source version read, so the record shows what it rested on.
    function evidence(set, judged, checkedAt) {
        return { set: { id: set.id, version: set.version }, checkedAt,
            houses: judged.map(({ id, result, sourceVersion = null }) => ({ id: id || null, verdict: id ? result.verdict : 'unknown',
                failing: result.tests.filter(test => test.status === 'fail').map(test => test.cite),
                unknown: result.tests.filter(test => test.status === 'unknown').map(test => test.cite),
                ...(sourceVersion ? { sourceVersion: { version: sourceVersion.version ?? null, changed: sourceVersion.changed ?? null } } : {}) })) };
    }

    const CITE = /^\d{1,2}(\.\d{1,2})?$/;
    const HOUSE_ID = /^osm:(way|relation)\/[1-9][0-9]{0,15}$/;
    // A recorded check, checked for shape (community/voting.js keeps it in the voting record).
    function normalizeEvidence(raw) {
        const fail = message => { throw new Error(message); };
        if (!raw || typeof raw !== 'object' || !raw.set || !get(raw.set.id, raw.set.version)) fail('The eligibility check names an unknown rule set.');
        if (typeof raw.checkedAt !== 'string' || !Number.isFinite(Date.parse(raw.checkedAt))) fail('The eligibility check needs its time.');
        if (!Array.isArray(raw.houses) || !raw.houses.length || raw.houses.length > 500) fail('The eligibility check needs 1–500 houses.');
        const houses = raw.houses.map(house => {
            if (!house || (house.id !== null && !HOUSE_ID.test(String(house.id))) || !['eligible', 'ineligible', 'unknown'].includes(house.verdict)
                || ![house.failing, house.unknown].every(list => Array.isArray(list) && list.length <= 20 && list.every(cite => CITE.test(cite)))) {
                fail('An eligibility house entry is malformed.');
            }
            const version = house.sourceVersion;
            return { id: house.id, verdict: house.verdict, failing: [...house.failing], unknown: [...house.unknown],
                ...(version && typeof version === 'object' ? { sourceVersion: { version: Number.isInteger(version.version) ? version.version : null,
                    changed: typeof version.changed === 'string' ? version.changed : null } } : {}) };
        });
        return { set: { id: raw.set.id, version: raw.set.version }, checkedAt: new Date(Date.parse(raw.checkedAt)).toISOString(), houses };
    }

    // Why a recorded check does not let the vote start: [] when it covers exactly the plan's houses
    // and found each one eligible.
    function evidenceIssues(set, recorded, houses) {
        if (!houses.length) return [{ code: 'eligibility-no-houses' }];
        if (!recorded || recorded.set.id !== set.id || recorded.set.version !== set.version) return [{ code: 'eligibility-missing' }];
        const wanted = houses.map(house => String(house.id)).sort(), got = recorded.houses.map(house => String(house.id)).sort();
        if (wanted.length !== got.length || wanted.some((id, i) => id !== got[i])) return [{ code: 'eligibility-stale' }];
        const blocked = recorded.houses.filter(house => house.verdict !== 'eligible');
        return blocked.length ? [{ code: 'eligibility-failed', houses: blocked }] : [];
    }

    return { RULE_SETS, get, latest, forCity, evaluate, coveredHouses, check, evidence, normalizeEvidence, evidenceIssues };
});
