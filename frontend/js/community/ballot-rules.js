// Ballot rules: dated decision thresholds a community code vote can pin (`consultation.voting.rule`),
// and the one evaluation both the API summary and the browser tally use. A rule only counts the
// resident ballots; owner sign-off stays a separate owners' agreement on the same plan.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CommunityBallotRules = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    // The exact-fraction threshold shape and comparison are the owners' approval engine's.
    const approval = () => root.ProposalApproval
        || (typeof require === 'function' ? require('../proposals/approval.js') : null);

    // A rule's version is the date its thresholds were checked against the sources (each entry's own). A published
    // agreement pins id@version, so a shipped version is never edited or removed: a re-check that
    // changes a rule adds a new entry beside it (backend/test/community-ballot-rules.test.js lists them).
    const CHECKED = '2026-11-25';
    const atLeast = (numerator, denominator) => ({ numerator, denominator, strict: false });
    // What each test counts, out of what. A household is one group of codes in the voting record's
    // `households`; without that list every code is a household of one. Abstain is a vote cast.
    //   cast-support:      codes voting Support / codes that voted
    //   eligible-support:  codes voting Support / all eligible codes
    //   household-turnout: households where any code voted / all households
    //   household-support: households where any code voted Support / households where any code voted
    const MEASURES = ['cast-support', 'eligible-support', 'household-turnout', 'household-support'];
    const test = (measure, threshold) => ({ measure, ...threshold });

    // English text is the fallback for the `voting.ballotRules.<id>.*` i18n keys.
    const RULES = [
        {
            id: 'gb-street-vote-strong-suburbs', version: CHECKED, country: 'GB',
            tests: [test('cast-support', atLeast(3, 5)), test('household-turnout', atLeast(1, 2)), test('household-support', atLeast(1, 2))],
            sources: [{ label: 'Policy Exchange, Strong Suburbs (2021), p. 39', url: 'https://policyexchange.org.uk/wp-content/uploads/2022/10/Strong-Suburbs.pdf' }],
            text: {
                name: 'Street vote — Strong Suburbs',
                source: 'Proposed in Policy Exchange’s Strong Suburbs (2021): at least 60% of votes cast in favour, residents of at least half the households voting, and a yes from a resident in at least half of the voting households.'
            }
        },
        {
            id: 'gb-street-vote-consultation-2023', version: CHECKED, country: 'GB',
            tests: [test('eligible-support', atLeast(3, 5)), test('household-support', atLeast(1, 2))],
            sources: [{ label: 'Street vote development orders consultation (22 December 2023), para. 69', url: 'https://www.gov.uk/government/consultations/street-vote-development-orders-consultation/street-vote-development-orders' }],
            text: {
                name: 'Street vote — 2023 government consultation',
                source: 'Proposed in the government’s December 2023 street vote development orders consultation: at least 60% of those eligible to vote in favour, and at least one voter in at least half of the voting households in favour.'
            }
        },
        {
            // A vote for mansards may cover only houses that meet the paper's eligibility conditions
            // (para. 17, planning/eligibility.js): the agreement records that check and cannot be
            // created until every covered house passes it.
            id: 'gb-street-vote-living-tradition', version: '2026-11-27', country: 'GB',
            tests: [test('cast-support', atLeast(1, 2)), test('household-turnout', atLeast(1, 2)), test('household-support', atLeast(1, 2))],
            requires: { eligibility: { id: 'gb-living-tradition-mansards', version: '2026-11-27' } },
            sources: [{ label: 'Samuel Hughes, Living Tradition (Create Streets, 2021), paras 8–17', url: 'https://www.createstreets.com/wp-content/uploads/2025/07/Living-Tradition.pdf' }],
            text: {
                name: 'Street vote — Living Tradition mansards',
                source: 'Proposed in Samuel Hughes’s Living Tradition (Create Streets, 2021): at least 50% of votes cast in favour, residents of at least half the households voting, and a yes from a resident in at least half of the voting households. Only houses that meet its eligibility conditions (para. 17) may be covered.'
            }
        }
    ];
    const byKey = new Map(RULES.map(rule => [`${rule.id}@${rule.version}`, rule]));
    function latest(id) {
        return RULES.filter(rule => rule.id === id).sort((a, b) => (a.version < b.version ? 1 : -1))[0] || null;
    }
    // What a new vote can choose: the newest version of each rule; older ones stay readable by get().
    function list() { return RULES.filter(rule => latest(rule.id) === rule); }
    function get(id, version) { return byKey.get(`${id}@${version}`) || null; }
    const needsHouseholds = rule => !!rule?.tests.some(row => row.measure.startsWith('household-'));

    // Households of a voting configuration: its partition, or one household per code.
    const householdsOf = config => config.households || config.codeHashes.map(hash => [hash]);

    /**
     * Counts a vote's latest ballots against a rule. Pure, aggregates only.
     * @param {object|null} rule a RULES entry (null: households only, no tests)
     * @param {{ codeHashes: string[], households?: string[][] }} config the normalized voting record
     * @param {Array<{ codeHash: string, choice: string|null }>} ballots each code's latest choice
     * @returns {{ households: { eligible, voted, supporting }, tests: Array<{ measure, count, total,
     *   numerator, denominator, strict, needed, met }>, passed: boolean|null }}
     *   A test of an empty total (no household voted yet) is not met; `passed` is null without a rule.
     */
    function evaluate(rule, config, ballots) {
        const eligible = new Set(config.codeHashes);
        const choice = new Map();
        for (const row of ballots || []) if (eligible.has(row.codeHash) && row.choice) choice.set(row.codeHash, row.choice);
        const support = [...choice.values()].filter(value => value === 'support').length;
        const groups = householdsOf(config);
        const voted = groups.filter(group => group.some(hash => choice.has(hash))).length;
        const supporting = groups.filter(group => group.some(hash => choice.get(hash) === 'support')).length;
        const totals = {
            'cast-support': [support, choice.size],
            'eligible-support': [support, eligible.size],
            'household-turnout': [voted, groups.length],
            'household-support': [supporting, voted]
        };
        const A = approval();
        const tests = (rule?.tests || []).map(row => {
            const [count, total] = totals[row.measure];
            const share = { n: BigInt(count), d: 1n }, whole = { n: BigInt(total), d: 1n };
            return { measure: row.measure, count, total, numerator: row.numerator, denominator: row.denominator, strict: row.strict,
                needed: A.needed({ ...row, measure: 'headcount' }, whole), met: total > 0 && A.passes(share, whole, row) };
        });
        return { households: { eligible: groups.length, voted, supporting }, tests, passed: rule ? tests.every(row => row.met) : null };
    }

    return { CHECKED, MEASURES, RULES, list, get, latest, needsHouseholds, householdsOf, evaluate };
});
