// Building eligibility: whether an existing building meets a rule set's conditions on what it is —
// its age, form and stated facts — test by test. Rules are data; each test reads building facts (the
// shared API's building-facts contract, buildings/building-facts.js) or the footprint and its
// neighbours. A test is unknown while its fact is, and a condition no source states yet is listed
// as unchecked, never assumed. Pure: geometry operations are passed in. Used by the building card,
// and by the street vote whose ballot rule requires the set (community/ballot-rules.js).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BuildingEligibility = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    // Two footprints are one terrace when their outlines share at least this much wall.
    const PARTY_WALL_M = 1.5;
    // Neighbours further than this from the building are not looked at.
    const NEIGHBOUR_REACH_M = 60;
    const finite = value => typeof value === 'number' && Number.isFinite(value);

    // A rule set is dated like a ballot rule: a published vote pins id@version, so a shipped version
    // is never edited; a re-check adds a new entry. English text is the fallback for the
    // `eligibility.<id>.*` i18n keys.
    const RULE_SETS = [{
        id: 'gb-living-tradition-mansards', version: '2026-11-27', planningRuleSet: 'gb-eng-planning',
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
            { id: 'attached', cite: '17.6', check: 'attached', minRow: 3 },
            { id: 'footprint', cite: '17.7', check: 'footprintAtMost', maxM2: 100 },
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

    // The terrace a building stands in: itself and every footprint joined to it through party walls.
    // Null while the neighbours are not known.
    function rowSize(footprint, neighbours, ops) {
        if (!Array.isArray(neighbours)) return null;
        // The building itself may be among its neighbours as another copy of the same outline.
        const near = neighbours.filter(other => ops.distanceM(footprint, other) <= NEIGHBOUR_REACH_M && !ops.sameOutline(footprint, other));
        const row = [footprint], seen = new Set([footprint]);
        for (let i = 0; i < row.length; i++) {
            for (const other of near) {
                if (seen.has(other) || row.some(member => ops.sameOutline(member, other))) continue;
                // Only touching outlines can share a wall; the overlap is measured for those alone.
                if (ops.distanceM(row[i], other) <= 1 && ops.sharedWallM(row[i], other) >= PARTY_WALL_M) { seen.add(other); row.push(other); }
            }
        }
        return row.length;
    }

    // One test → { id, cite, status: pass | fail | unknown | unchecked, value }.
    function runTest(test, building, ops) {
        const { facts, footprint, neighbours } = building;
        const result = status => ({ id: test.id, cite: test.cite, status });
        switch (test.check) {
            case 'builtBetween': {
                const span = valueOf(facts, 'built');
                if (!span) return result('unknown');
                const { from, to } = span;
                if ((finite(from) && from >= test.before) || (finite(to) && to <= test.after)) return { ...result('fail'), value: span };
                // An open start ("before 1913") passes the lower bound only where the set says so.
                const afterKept = finite(from) ? from > test.after : test.openStartPasses === true;
                return { ...result(finite(to) && to < test.before && afterKept ? 'pass' : 'unknown'), value: span };
            }
            case 'factIs': {
                const value = valueOf(facts, test.fact);
                return value === null ? result('unknown') : { ...result(value === test.value ? 'pass' : 'fail'), value };
            }
            case 'factIsNot': {
                const value = valueOf(facts, test.fact);
                return value === null ? result('unknown') : { ...result(value === test.value ? 'fail' : 'pass'), value };
            }
            case 'factAtLeast': {
                const value = valueOf(facts, test.fact);
                return !finite(value) ? result('unknown') : { ...result(value >= test.min ? 'pass' : 'fail'), value };
            }
            case 'attached': {
                // A terrace of at least minRow, or a semi-detached pair (Living Tradition 17.6: a pair
                // may only add mansards together).
                const size = footprint ? rowSize(footprint, neighbours, ops) : null;
                if (size === null) return result('unknown');
                return { ...result(size >= test.minRow || size === 2 ? 'pass' : 'fail'), value: size };
            }
            case 'footprintAtMost': {
                const area = footprint ? ops.areaM2(footprint) : null;
                return !finite(area) ? result('unknown') : { ...result(area <= test.maxM2 ? 'pass' : 'fail'), value: Math.round(area) };
            }
            default: return result('unchecked');
        }
    }

    // A building ({ facts, footprint, neighbours }) under a rule set → each test's result and the
    // verdict: ineligible when a test fails, unknown while one is unknown, else eligible (with the
    // unchecked conditions listed beside it).
    function evaluate(set, building, ops) {
        const tests = set.tests.map(test => runTest(test, building, ops));
        const has = status => tests.some(test => test.status === status);
        return { set: { id: set.id, version: set.version }, verdict: has('fail') ? 'ineligible' : has('unknown') ? 'unknown' : 'eligible', tests };
    }

    // Geometry operations from turf (6 or 7): area, nearest distance and the length of shared outline.
    function turfOps(turf) {
        const lines = feature => {
            const line = turf.polygonToLine(feature);
            return line.type === 'FeatureCollection' ? line.features : [line];
        };
        return {
            areaM2: feature => turf.area(feature),
            // Two copies of one building: centres within a metre and areas within a tenth.
            sameOutline: (a, b) => {
                if (a === b) return true;
                const [ax, ay] = turf.centroid(a).geometry.coordinates, [bx, by] = turf.centroid(b).geometry.coordinates;
                const apart = Math.hypot((ax - bx) * 111320 * Math.cos(ay * Math.PI / 180), (ay - by) * 110540);
                const areaA = turf.area(a), areaB = turf.area(b);
                return apart < 1 && Math.abs(areaA - areaB) <= 0.1 * Math.max(areaA, areaB);
            },
            distanceM: (a, b) => {
                const [aw, as, ae, an] = turf.bbox(a), [bw, bs, be, bn] = turf.bbox(b);
                const dx = Math.max(0, bw - ae, aw - be), dy = Math.max(0, bs - an, as - bn);
                // Degrees to metres at the building's latitude; a bbox gap is a lower bound.
                return Math.hypot(dx * 111320 * Math.cos(((as + an) / 2) * Math.PI / 180), dy * 110540);
            },
            sharedWallM: (a, b) => {
                let metres = 0;
                for (const la of lines(a)) for (const lb of lines(b)) {
                    for (const part of turf.lineOverlap(la, lb, { tolerance: 0.0003 }).features) metres += turf.length(part) * 1000;
                }
                return metres;
            },
        };
    }

    return { RULE_SETS, get, latest, forCity, evaluate, turfOps, PARTY_WALL_M };
});
