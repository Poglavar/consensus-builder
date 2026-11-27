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
    //   household-eligible-support: households where any code voted Support / all households
    //   long-resident-support: long-resident codes voting Support / all long-resident codes (the voting
    //     record's `longResidents`: the codes of residents registered at the address for at least the
    //     rule's `longResidentYears`)
    const MEASURES = ['cast-support', 'eligible-support', 'household-turnout', 'household-support', 'household-eligible-support', 'long-resident-support'];
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
            // Para 2: the vote is held only "if the proposal complies with the rules applying to street
            // votes". The plan must claim the Strong Suburbs street code and the voting record keeps the
            // check of each of its buildings (planning/street-code.js); a building that breaks the code
            // or that the code excludes holds the vote back, one the app cannot judge yet does not.
            id: 'gb-street-vote-strong-suburbs', version: '2026-11-27', country: 'GB',
            tests: [test('cast-support', atLeast(3, 5)), test('household-turnout', atLeast(1, 2)), test('household-support', atLeast(1, 2))],
            requires: { streetCode: { id: 'gb-strong-suburbs-street-code', version: '2021' } },
            sources: [{ label: 'Policy Exchange, Strong Suburbs (2021), paras 2 and 4, p. 39', url: 'https://policyexchange.org.uk/wp-content/uploads/2022/10/Strong-Suburbs.pdf' }],
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
        },
        {
            // Create Mews' block plan vote, held on a block (`unit: 'block'`, the voting record's `block`):
            // para 6 (a) two-thirds of eligible voters in favour, (b) a resident of at least half the
            // eligible households in favour, (c) at least half of those registered at their address for
            // three years or more in favour; para 5, at least twenty households; para 4, only on a plan
            // that complies with the rules (its block plan code).
            id: 'gb-block-vote-create-mews', version: '2026-11-27', country: 'GB', unit: 'block', minHouseholds: 20, longResidentYears: 3,
            tests: [test('eligible-support', atLeast(2, 3)), test('household-eligible-support', atLeast(1, 2)), test('long-resident-support', atLeast(1, 2))],
            requires: { streetCode: { id: 'gb-create-mews-block-code', version: '2022' } },
            sources: [{ label: 'Ben Southwood and Samuel Hughes, Create Mews (Create Streets, 2022), paras 4–6, pp. 48–49', url: 'https://www.createstreets.com/wp-content/uploads/2022/02/Create-Mews.pdf' }],
            text: {
                name: 'Block vote — Create Mews',
                source: 'Proposed in Create Streets’ Create Mews (2022): a block of at least twenty households adopts a block plan when at least two-thirds of eligible voters vote in favour, a resident of at least half the households votes in favour, and at least half of those registered at their address for three years or more vote in favour.'
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
    const needsLongResidents = rule => !!rule?.tests.some(row => row.measure === 'long-resident-support');

    // Households of a voting configuration: its partition, or one household per code.
    const householdsOf = config => config.households || config.codeHashes.map(hash => [hash]);

    /**
     * Counts a vote's latest ballots against a rule. Pure, aggregates only.
     * @param {object|null} rule a RULES entry (null: households only, no tests)
     * @param {{ codeHashes: string[], households?: string[][], longResidents?: string[] }} config the normalized voting record
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
        const long = config.longResidents || [];
        const totals = {
            'cast-support': [support, choice.size],
            'eligible-support': [support, eligible.size],
            'household-turnout': [voted, groups.length],
            'household-support': [supporting, voted],
            'household-eligible-support': [supporting, groups.length],
            'long-resident-support': [long.filter(hash => choice.get(hash) === 'support').length, long.length]
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

    return { CHECKED, MEASURES, RULES, list, get, latest, needsHouseholds, needsLongResidents, householdsOf, evaluate };
});
