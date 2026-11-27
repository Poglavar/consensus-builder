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
            // "No front gable or half-dormers": a parapet along the whole street front (17.2, the
            // building:parapet tag's meaning) leaves no room for either, so it passes. Without one the
            // front may show plain eaves, a gable or a half-dormer, which no source tells apart: not
            // checked, so this test never changes a house's verdict, only shows what 17.2 settles.
            { id: 'frontGable', cite: '17.3', check: 'passWhenFact', fact: 'parapet', value: true },
            { id: 'noMansard', cite: '17.4', check: 'factIsNot', fact: 'roof_shape', value: 'mansard' },
            { id: 'storeys', cite: '17.5', check: 'factAtLeast', fact: 'storeys', min: 2 },
            // A terrace of at least three, or a semi-detached pair (17.6: a pair adds mansards together).
            { id: 'attached', cite: '17.6', check: 'row', fact: 'row_size', minRow: 3, pairPasses: true },
            { id: 'footprint', cite: '17.7', check: 'factAtMost', fact: 'footprint_m2', max: 100 },
            { id: 'originalUse', cite: '17.8', check: 'unchecked' },
            // "Not listed Grade I or II*": the heritage fact (the country's register). Grade II passes;
            // a listing whose grade the register does not state is unknown.
            { id: 'listing', cite: '17.9', check: 'gradeNotIn', fact: 'heritage', grades: ['I', 'II*'] },
            { id: 'topWindows', cite: '17.10', check: 'unchecked' },
        ],
    }, {
        // A street code (`kind: 'street-code'`): the limits a street plan's buildings must keep. A plan
        // names the codes it claims to respect (plan-record.js `codes`); the claim is checked here, per
        // building of the plan, never trusted. Each building's facts are its building facts (raised
        // existing ones only) and the facts planning/street-code.js derives from the design and the
        // place. `applies`: 'existing' (a raised existing building), 'new', 'setback' (a building with a
        // setback storey) or every building; a test that does not apply is `notApplicable`. `effect`:
        // 'excluded' takes the building out of what a street vote may change, otherwise the plan breaks
        // the code. Paragraph numbers are Strong Suburbs' (pages 41–54).
        id: 'gb-strong-suburbs-street-code', version: '2021', kind: 'street-code', planningRuleSet: 'gb-eng-planning',
        ballotRules: ['gb-street-vote-strong-suburbs'],
        source: { label: 'Samuel Hughes and Ben Southwood, Strong Suburbs (Policy Exchange, 2021), paras 12–15, 30–42, 51–57', url: 'https://policyexchange.org.uk/wp-content/uploads/2022/10/Strong-Suburbs.pdf' },
        text: { name: 'Strong Suburbs street code' },
        // Para 30: the lower of the caps of every small area a property on the street falls in or that
        // lies within 200 m of the street; people per hectare. "Between 20 and 60" and "between 60 and
        // 120" share their ends: a density of exactly 60 takes the lower cap (the paragraph's "lower of").
        density: { reachM: 200, bands: [{ below: 20, storeys: 2 }, { atMost: 60, storeys: 3 }, { atMost: 120, storeys: 4 }, { storeys: 5 }] },
        // Paras 31–32: one setback storey under 75° everywhere, a second under 32.5° where four or five storeys are permitted.
        setbacks: { first: { degrees: 75 }, second: { degrees: 32.5, minCap: 4 } },
        // Para 37: ten or more buildings built before 1918 within 100 m of the street restrict it to 3+1,
        // unless half the buildings on the street already have more floors (then the existing total).
        historic: { reachM: 100, builtBefore: 1918, count: 10, storeys: 3, setbacks: 1, streetReachM: 40 },
        // Para 54: a neighbour on another street is owed compensation for building over a 30° angle of
        // elevation from the boundary of their plot (Effects on neighbours, `boundary`).
        neighbourGuides: { boundary: { degrees: 30, effect: 'compensation', cite: '54' } },
        // Light planes (planning/light-planes.js) the `underPlane` tests read, by where they rise from:
        // `otherStreetPlots`, the plots near the plan not on the voted street (para 35.1: 45° on a line
        // running north of due east or west, else 35° plus a ninth of its angle from due south);
        // `neighbourPlots`, the plots beside a building not attached to it (para 52, 70°).
        planes: {
            otherStreets: { from: 'otherStreetPlots', angle: { northOfEastWest: 45, fromSouth: { base: 35, perDegree: 1 / 9 } } },
            detached: { from: 'neighbourPlots', angle: 70, unattached: true },
        },
        tests: [
            { id: 'ssListed', cite: '12', applies: 'existing', check: 'notListed', fact: 'heritage', effect: 'excluded' },
            { id: 'ssPre1918', cite: '13', applies: 'existing', check: 'builtFrom', min: 1918, effect: 'excluded' },
            // "Undeveloped Green Belt land": a raised existing building stands on developed land.
            { id: 'ssGreenBelt', cite: '14', applies: 'new', check: 'notInAreas', fact: 'designations', datasets: ['green-belt'], effect: 'excluded' },
            { id: 'ssOpenLand', cite: '14', check: 'unchecked', reason: 'noSource' },
            { id: 'ssNature', cite: '15', check: 'notInAreas', fact: 'designations', datasets: ['national-park', 'area-of-outstanding-natural-beauty', 'site-of-special-scientific-interest'], effect: 'excluded' },
            { id: 'ssStoreys', cite: '30', check: 'atMostFact', fact: 'proposed_storeys', limit: 'storey_cap' },
            { id: 'ssSetbackPlane', cite: '31', applies: 'setback', check: 'factIs', fact: 'setback_under_plane', value: true },
            { id: 'ssSetbacks', cite: '32', applies: 'setback', check: 'atMostFact', fact: 'proposed_setbacks', limit: 'setbacks_allowed' },
            // Para 35: a private right of the neighbours on other streets, which they may waive.
            { id: 'ssLightPlanes', cite: '35', check: 'underPlane', fact: 'plane_otherStreets', effect: 'waivable' },
            // Ceilings: the design states storey heights (floor to floor); a ceiling is lower by the
            // floor's thickness, which it does not state. So a storey of at most 3.5 m keeps the
            // maximum and one under 2.5 m breaks the minimum; anything else is unknown.
            { id: 'ssCeilingMax', cite: '36', check: 'boundAtMost', fact: 'storey_height_m', max: 3.5 },
            { id: 'ssCeilingMin', cite: '36', check: 'boundBelowFails', fact: 'storey_height_m', min: 2.5 },
            { id: 'ssSetbackCeiling', cite: '36', applies: 'setback', check: 'boundAtMost', fact: 'setback_rise_m', max: 3 },
            { id: 'ssAddedCeiling', cite: '36.2', applies: 'existing', check: 'unchecked', reason: 'ceilings' },
            { id: 'ssHistoric', cite: '37', check: 'atMostFact', fact: 'proposed_storeys', limit: 'historic_storeys' },
            { id: 'ssPlotUse', cite: '39', check: 'unchecked', reason: 'plotUse' },
            { id: 'ssFrontDoors', cite: '41', check: 'unchecked', reason: 'doors' },
            { id: 'ssSideWindows', cite: '42', check: 'unchecked', reason: 'windows' },
            { id: 'ssSemiDetached', cite: '51', check: 'unchecked', reason: 'consent' },
            // Para 52: above 70° from the border with a neighbour not attached, only with their consent.
            { id: 'ssDetached', cite: '52', check: 'underPlane', fact: 'plane_detached', effect: 'waivable' },
        ],
    }, {
        // Create Mews' block plan code (Ben Southwood and Samuel Hughes, Create Streets, February 2022):
        // the most a block plan may permit, voted by the block's residents in "this form of street vote"
        // (para 5), so it is a street code whose vote is held on a block. Paragraph numbers are its
        // Detailed proposals' (pages 47–58); para 26's rules are its lettered sub-paragraphs (26a).
        id: 'gb-create-mews-block-code', version: '2022', kind: 'street-code', planningRuleSet: 'gb-eng-planning',
        ballotRules: ['gb-block-vote-create-mews'],
        source: { label: 'Ben Southwood and Samuel Hughes, Create Mews (Create Streets, 2022), paras 1, 11–14, 26 and 28', url: 'https://www.createstreets.com/wp-content/uploads/2022/02/Create-Mews.pdf' },
        text: { name: 'Create Mews block plan code' },
        // Para 26: a. 20° from the block's boundary with the streets around it, raised without rotation
        // over a building in between; e. 70° from each boundary between plots, waivable by the owner it
        // protects; f. 40° from the boundary of the other plots, above which terraces are set back and
        // windows translucent unless that owner waives it; h. at most 9 m above the block's tallest
        // existing building.
        planes: {
            street: { from: 'blockEdge', angle: 20, raisedBy: 'existing' },
            plots: { from: 'blockPlots', angle: 70 },
            privacy: { from: 'blockPlots', angle: 40 },
        },
        tallest: { overM: 9 },
        tests: [
            { id: 'cmListed', cite: '11', applies: 'existing', check: 'notListed', fact: 'heritage', effect: 'excluded' },
            { id: 'cmPre1918', cite: '12', applies: 'existing', check: 'builtFrom', min: 1918, effect: 'excluded' },
            { id: 'cmGreenBelt', cite: '13', applies: 'new', check: 'notInAreas', fact: 'designations', datasets: ['green-belt'], effect: 'excluded' },
            { id: 'cmOpenLand', cite: '13', check: 'unchecked', reason: 'parksFarmland' },
            { id: 'cmNature', cite: '14', check: 'notInAreas', fact: 'designations', datasets: ['national-park', 'area-of-outstanding-natural-beauty', 'site-of-special-scientific-interest'], effect: 'excluded' },
            { id: 'cmBlockSize', cite: '1', check: 'unchecked', reason: 'blockBuildings' },
            { id: 'cmStreetPlane', cite: '26a', check: 'underPlane', fact: 'plane_street' },
            { id: 'cmStreetFronts', cite: '26b', check: 'unchecked', reason: 'fronts' },
            { id: 'cmInfill', cite: '26c', check: 'unchecked', reason: 'infill' },
            { id: 'cmRailways', cite: '26d', check: 'unchecked', reason: 'railways' },
            { id: 'cmPlotPlane', cite: '26e', check: 'underPlane', fact: 'plane_plots', effect: 'waivable' },
            { id: 'cmPrivacyPlane', cite: '26f', check: 'underPlane', fact: 'plane_privacy', effect: 'waivable' },
            { id: 'cmBuffers', cite: '26g', check: 'unchecked', reason: 'buffers' },
            { id: 'cmTallest', cite: '26h', check: 'heightOver', fact: 'proposed_top_m', limit: 'tallest_existing_m', overM: 9 },
            { id: 'cmCeilingMin', cite: '28', check: 'boundBelowFails', fact: 'storey_height_m', min: 2.5 },
        ],
    }];
    const byKey = new Map(RULE_SETS.map(set => [`${set.id}@${set.version}`, set]));
    const get = (id, version) => byKey.get(`${id}@${version}`) || null;
    const latest = id => RULE_SETS.filter(set => set.id === id).sort((a, b) => (a.version < b.version ? 1 : -1))[0] || null;
    // The newest version of each set of a kind (building eligibility, or 'street-code') that applies
    // under a city's planning rule sets.
    function forCity(planningRuleSetIds = [], { kind = 'building' } = {}) {
        return RULE_SETS.filter(set => latest(set.id) === set && (set.kind || 'building') === kind && planningRuleSetIds.includes(set.planningRuleSet));
    }
    // The street codes a ballot rule can carry a check of.
    const codesForBallot = rule => RULE_SETS.filter(set => set.kind === 'street-code' && rule && set.ballotRules?.includes(rule.id));

    const valueOf = (facts, name) => (facts && facts[name] ? facts[name].value : null);

    // Whether a test applies to a building, by its `kind` fact (street codes: 'existing' or 'new') and
    // its setback storeys; a set whose facts carry no kind (building eligibility) applies every test.
    function applies(test, facts) {
        if (!test.applies) return true;
        const kind = valueOf(facts, 'kind');
        if (test.applies === 'setback') { const setbacks = valueOf(facts, 'proposed_setbacks'); return !finite(setbacks) || setbacks > 0; }
        return kind === null || kind === test.applies;
    }

    // One test → { id, cite, status: pass | fail | unknown | unchecked | notApplicable, value }.
    // The operators are a closed set: builtBetween, builtFrom, factIs, factIsNot, factAtLeast,
    // factAtMost, atMostFact (a fact against a limit fact; a limit of false means no limit),
    // boundAtMost and boundBelowFails (the fact is an upper bound of what the rule limits: a bound
    // within the maximum passes, one under the minimum fails, else unknown), gradeNotIn, notListed,
    // notInAreas (the designation datasets a building lies in), passWhenFact (passes when a fact
    // that implies the condition holds, else unchecked), underPlane (a light plane's reading:
    // { status: clear | pierced | unknown, parcels } from planning/street-code.js), heightOver (a
    // height at most `overM` above a limit fact, which may be known only as a lower `bound`), row and
    // unchecked.
    function runTest(test, facts) {
        const result = (status, value) => ({ id: test.id, cite: test.cite, status, ...(value === undefined ? {} : { value }) });
        if (!applies(test, facts)) return result('notApplicable');
        const value = test.fact ? valueOf(facts, test.fact) : null;
        switch (test.check) {
            case 'builtFrom': {
                const span = valueOf(facts, 'built');
                if (!span) return result('unknown');
                if (finite(span.from) && span.from >= test.min) return result('pass', span);
                return result(finite(span.to) && span.to < test.min ? 'fail' : 'unknown', span);
            }
            case 'atMostFact': {
                const limit = valueOf(facts, test.limit);
                if (limit === false) return result('pass', value);
                return !finite(value) || !finite(limit) ? result('unknown', finite(value) ? value : undefined) : { ...result(value <= limit ? 'pass' : 'fail', value), limit };
            }
            case 'boundAtMost': return !finite(value) ? result('unknown') : result(value <= test.max ? 'pass' : 'unknown', value);
            case 'boundBelowFails': return !finite(value) ? result('unknown') : result(value < test.min ? 'fail' : 'unknown', value);
            case 'notListed': return !value || typeof value.listed !== 'boolean' ? result('unknown')
                : { ...result(value.listed ? 'fail' : 'pass', value.listed ? 'listed' : 'not listed'), ...(value.grade ? { grade: value.grade } : {}) };
            case 'notInAreas': {
                if (!Array.isArray(value)) return result('unknown');
                const inside = value.filter(dataset => test.datasets.includes(dataset));
                return result(inside.length ? 'fail' : 'pass', inside);
            }
            case 'builtBetween': {
                const span = valueOf(facts, 'built');
                if (!span) return result('unknown');
                const { from, to } = span;
                if ((finite(from) && from >= test.before) || (finite(to) && to <= test.after)) return result('fail', span);
                // An open start ("before 1913") passes the lower bound only where the set says so.
                const afterKept = finite(from) ? from > test.after : test.openStartPasses === true;
                return result(finite(to) && to < test.before && afterKept ? 'pass' : 'unknown', span);
            }
            case 'passWhenFact': return value === test.value ? result('pass', value) : result('unchecked');
            case 'underPlane': {
                if (!value || !['clear', 'pierced'].includes(value.status)) return result('unknown');
                return value.status === 'clear' ? result('pass') : { ...result('fail', value.clearM ?? undefined), parcels: [...(value.parcels || [])] };
            }
            case 'heightOver': {
                const limit = facts?.[test.limit] || null;
                if (!finite(value)) return result('unknown');
                if (limit && finite(limit.value)) return { ...result(value <= limit.value + test.overM ? 'pass' : 'fail', value), limit: limit.value + test.overM };
                // Known only as at least `bound`: within bound + overM passes for certain.
                return limit && finite(limit.bound) && value <= limit.bound + test.overM ? { ...result('pass', value), limit: limit.bound + test.overM } : result('unknown', value);
            }
            case 'factIs': return value === null ? result('unknown') : result(value === test.value ? 'pass' : 'fail', value);
            case 'factIsNot': return value === null ? result('unknown') : result(value === test.value ? 'fail' : 'pass', value);
            case 'factAtLeast': return !finite(value) ? result('unknown') : result(value >= test.min ? 'pass' : 'fail', value);
            case 'factAtMost': return !finite(value) ? result('unknown') : result(value <= test.max ? 'pass' : 'fail', value);
            case 'gradeNotIn': {
                if (!value || typeof value.listed !== 'boolean') return result('unknown');
                if (!value.listed) return result('pass', 'not listed');
                if (!value.grade) return result('unknown');
                return { ...result(test.grades.includes(value.grade) ? 'fail' : 'pass', value.grade), grade: value.grade };
            }
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

    // The fact a test reads (the date tests read `built`).
    const factOf = test => test.fact || (['builtBetween', 'builtFrom'].includes(test.check) ? 'built' : null);
    // Why a house is not eligible, test by test, in the words and links the building card uses
    // (buildings/building-facts.js factRow): each failing or unknown test with its label and status,
    // the fact's value in words, the source's key to add a missing fact under, the reason a register
    // gives for an unknown one, and the register entry link. `t` translates the card's keys
    // (`buildingFact.*`, `eligibility.*`); `building` is the contract's answer, or null.
    // `facts`, when given, are the facts the result was judged on: a fact a street code derives
    // (planning/street-code.js, `derived: true`) is told in its own words (`eligibility.fact.<name>`
    // with the fact's `params`), with the limit it was read against.
    function explain(set, result, building, t, facts = null) {
        return result.tests.filter(test => test.status === 'fail' || test.status === 'unknown').map(test => {
            const definition = set.tests.find(entry => entry.id === test.id) || {};
            const field = factOf(definition);
            const derived = field && facts?.[field]?.derived ? facts[field] : null;
            const limit = definition.limit && facts?.[definition.limit]?.derived ? facts[definition.limit] : null;
            const words = fact => fact ? t(`eligibility.fact.${fact.name}`, fact.params || {}) : null;
            const row = derived ? { text: [words(derived), words(limit)].filter(Boolean).join(' · ') || null, raw: null, key: null, reason: null, link: limit?.link || derived.link || null }
                : field && building?.facts ? factsApi().factRow(building, field, (key, params) => t(`buildingFact.${key}`, params)) : null;
            const status = t(`eligibility.status.${test.status}`);
            return { cite: test.cite, id: test.id, status: test.status, label: t(`eligibility.test.${test.id}`),
                statusText: test.grade ? t('eligibility.withGrade', { status, grade: test.grade }) : status,
                text: row?.text ?? null, raw: row?.raw ?? null, key: row?.key ?? null, reason: row?.reason ?? null, link: row?.link ?? null,
                // Where to add a missing fact: the source's key, on the building's edit page.
                add: test.status === 'unknown' && row && !row.text && row.key && building?.edit?.url ? { key: row.key, source: building.edit.source, url: building.edit.url } : null };
        });
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

    // ── a street code a street vote requires (community/ballot-rules.js `requires.streetCode`) ──
    const cidApi = () => (root && root.Cid) || require('../cid.js');
    const streetsApi = () => (root && root.StreetSegments) || require('../streets/street-segments.js');
    // A building's verdict under a street code, by its failing tests' effect: 'excluded' when a test
    // whose failure takes it out of what a street vote may change fails, 'breaks' when another fails
    // that no one can waive, 'waivable' when it fails only tests the protected neighbours may waive
    // (their waivers are given in an owners' agreement, the affected parcels of the plan), 'unknown'
    // while a test is unknown, else 'meets'. Only the first two hold the vote back.
    const CODE_VERDICTS = ['meets', 'breaks', 'excluded', 'unknown', 'waivable'];
    const CODE_BLOCKING = ['breaks', 'excluded'];
    const effectOf = (set, id) => set.tests.find(test => test.id === id)?.effect || null;
    function codeLists(set, result) {
        const ids = status => result.tests.filter(test => test.status === status).map(test => test.id);
        const failed = ids('fail');
        return { failing: failed.filter(id => effectOf(set, id) !== 'excluded'), excluded: failed.filter(id => effectOf(set, id) === 'excluded'), unknown: ids('unknown') };
    }
    const verdictOfLists = (set, { failing, excluded, unknown }) => (excluded.length ? 'excluded'
        : failing.some(id => effectOf(set, id) !== 'waivable') ? 'breaks' : failing.length ? 'waivable' : unknown.length ? 'unknown' : 'meets');
    const codeVerdict = (set, result) => verdictOfLists(set, codeLists(set, result));
    // The plots whose owners may waive what a building's waivable failures break, by test id.
    function waiverPlots(set, result) {
        return result.tests.filter(test => test.status === 'fail' && effectOf(set, test.id) === 'waivable')
            .map(test => ({ id: test.id, cite: test.cite, parcels: test.parcels || [] }));
    }
    // The street a check read, as the record keys it: the CID of the vote's street reference without
    // its corner plots, which the check does not read; null when the vote names no street.
    function streetKey(street) {
        if (!street) return null;
        const { corners: _corners, ...read } = streetsApi().normaliseReference(street);
        return cidApi().cidOfObject(read);
    }
    // A vote held on a block (community/voting.js `block`, its plots as a parcel set) is keyed by
    // that set instead: the record's `street` field names whichever unit the check read.
    const blockKey = block => cidApi().cidOfObject({ block: { parcelSourceId: block.parcelSourceId, parcelIds: [...block.parcelIds].map(String).sort() } });
    const unitKey = (street, block) => (block ? blockKey(block) : streetKey(street));
    /**
     * What a street vote records of its street code check (planning/street-code.js check()): the code,
     * when, the plan (its CID) and street it read, and each building of the plan with its verdict and
     * the ids of the tests it breaks, is excluded by or leaves unknown.
     */
    function codeEvidence(set, outcome, { planCid, street = null, block = null }, checkedAt) {
        return { set: { id: set.id, version: set.version }, checkedAt, planCid, street: unitKey(street, block),
            buildings: outcome.buildings.map(building => {
                const lists = codeLists(set, building.result);
                return { design: building.design, index: building.index, factId: building.factId || null, kind: building.kind, verdict: verdictOfLists(set, lists), ...lists };
            }) };
    }
    const exactKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
    // A recorded street code check, checked for shape; a verdict must follow from its test lists.
    function normalizeCodeEvidence(raw) {
        const fail = message => { throw new Error(message); };
        if (!exactKeys(raw, ['set', 'checkedAt', 'planCid', 'street', 'buildings'])) fail('The street code check is malformed.');
        const set = raw.set && get(raw.set.id, raw.set.version);
        if (!set || set.kind !== 'street-code') fail('The street code check names an unknown street code.');
        if (typeof raw.checkedAt !== 'string' || !Number.isFinite(Date.parse(raw.checkedAt))) fail('The street code check needs its time.');
        if (!cidApi().isCid(raw.planCid)) fail('The street code check names the plan it read by CID.');
        if (raw.street !== null && !cidApi().isCid(raw.street)) fail('The street code check names the street it read by CID, or none.');
        if (!Array.isArray(raw.buildings) || raw.buildings.length > 500) fail('The street code check lists at most 500 buildings.');
        const testIds = new Set(set.tests.map(test => test.id));
        const buildings = raw.buildings.map(building => {
            const lists = ['failing', 'excluded', 'unknown'];
            if (!exactKeys(building, ['design', 'index', 'factId', 'kind', 'verdict', ...lists])
                || !Number.isInteger(building.design) || building.design < 0 || building.design > 999
                || !Number.isInteger(building.index) || building.index < 0 || building.index > 99999
                || (building.factId !== null && !HOUSE_ID.test(String(building.factId))) || !['existing', 'new'].includes(building.kind)
                || !CODE_VERDICTS.includes(building.verdict)
                || !lists.every(name => Array.isArray(building[name]) && building[name].length <= set.tests.length && building[name].every(id => testIds.has(id)))
                || !building.excluded.every(id => effectOf(set, id) === 'excluded') || building.failing.some(id => effectOf(set, id) === 'excluded')
                || verdictOfLists(set, building) !== building.verdict) {
                fail('A street code building entry is malformed.');
            }
            return { design: building.design, index: building.index, factId: building.factId, kind: building.kind, verdict: building.verdict,
                failing: [...building.failing], excluded: [...building.excluded], unknown: [...building.unknown] };
        });
        return { set: { id: set.id, version: set.version }, checkedAt: new Date(Date.parse(raw.checkedAt)).toISOString(), planCid: raw.planCid, street: raw.street, buildings };
    }
    /**
     * Why a recorded street code check does not let the vote start: [] when the plan claims the code,
     * the check read this plan and street, and no building breaks the code or is excluded by it.
     * Unknown and not-checked rules do not hold it back. `plan`: { cid, content } or null.
     */
    function codeIssues(set, recorded, { plan, street = null, block = null }) {
        if (plan && !(plan.content?.codes || []).some(code => code.id === set.id && code.version === set.version)) return [{ code: 'street-code-unclaimed' }];
        if (!recorded || recorded.set.id !== set.id || recorded.set.version !== set.version) return [{ code: 'street-code-missing' }];
        if ((plan && recorded.planCid !== plan.cid) || recorded.street !== unitKey(street, block)) return [{ code: 'street-code-stale' }];
        const blocked = recorded.buildings.filter(building => CODE_BLOCKING.includes(building.verdict));
        return blocked.length ? [{ code: 'street-code-failed', buildings: blocked }] : [];
    }

    return { RULE_SETS, get, latest, forCity, codesForBallot, evaluate, explain, coveredHouses, check, evidence, normalizeEvidence, evidenceIssues,
        CODE_VERDICTS, CODE_BLOCKING, codeVerdict, codeLists, waiverPlots, streetKey, blockKey, codeEvidence, normalizeCodeEvidence, codeIssues };
});
