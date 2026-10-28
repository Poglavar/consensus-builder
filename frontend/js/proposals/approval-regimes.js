// Agreement rules of real land readjustment schemes, as templates for a proposal's approval setup.
// Every scheme shares one deal (land in, sometimes cash; land and cash out). A template says only
// how it differs (land-readjustmend.md §§7–8, §23):
// - who decides and how: owner-support tests (approval.js) and how many authority decisions;
// - the stage the support qualifies for;
// - how land is distributed: by area, by value or either, caps on land given up, how much of a
//   value gain is settled in money, and how many parties the scheme needs.
// A proposal pins a template by id and version (approvalConfig.regime), so a later revision never
// changes rules people already signed. All templates are research: comparative findings checked on
// the dates below, not legal advice; a real procedure also needs its notices, hearings and registry.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApprovalRegimes = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // A template's version is the date its rules were last checked against the sources. A published
    // proposal pins id@version, so a version, once shipped, is never edited or removed: a re-check
    // that changes a scheme adds a new entry with the new date and leaves the old one beside it
    // (backend/test/proposal-approval-regimes.test.js lists every shipped version).
    const CHECKED = '2026-10-11';
    // 2026-10-28: value-basis settlement (valueGain) and party counts (minParties) were added to the
    // schemes that state them; those schemes have a second version, the others are unchanged.
    const CHECKED_VALUE = '2026-10-28';
    const atLeast = (numerator, denominator) => ({ numerator, denominator, strict: false });
    const moreThan = (numerator, denominator) => ({ numerator, denominator, strict: true });
    const test = (measure, of, scope, threshold) => ({ measure, of, scope, ...threshold });

    // family: 'voluntary' (the owners' agreement is the decision), 'support-and-authority' (owner
    // support, then an authority decides) or 'authority-led' (the authority decides; owners are heard).
    // allocation: basis ('area', 'value' or 'either'); cap (land given up: per owner or per pool, and
    // for which basis); valueGain (by value, the share of each owner's value gain that is settled in
    // money: Germany settles all of it, Gujarat charges half the increment, the rest keep it in land).
    // minParties: the fewest input parties the scheme takes (kavelruil needs three, Colombia two).
    // English text is the fallback for the `proposalApproval.schemes.<id>.*` i18n keys; `authority` is a noun phrase
    // ("the prefectural governor’s approval") that completes "…, and needs …".
    const REGIMES = [
        {
            id: 'nl-kavelruil', version: CHECKED, family: 'voluntary', country: 'NL', stage: 'agreement',
            tests: [test('headcount', 'owners', 'all', atLeast(1, 1))], authorities: 0,
            allocation: { basis: 'either' },
            sources: [{ label: 'IPLO — kavelruil', url: 'https://iplo.nl/thema/ruimtelijke-ontwikkelingen/instrumenten-grondbeleid/kavelruil/' }],
            text: {
                name: 'Netherlands — voluntary urban land exchange (kavelruil)',
                note: 'Every party agrees. The exchange is then set down in a notarial deed and registered with the Kadaster; at least three parties take part.'
            }
        },
        {
            id: 'nl-kavelruil', version: CHECKED_VALUE, family: 'voluntary', country: 'NL', stage: 'agreement',
            tests: [test('headcount', 'owners', 'all', atLeast(1, 1))], authorities: 0,
            allocation: { basis: 'either' }, minParties: 3,
            sources: [{ label: 'IPLO — kavelruil', url: 'https://iplo.nl/thema/ruimtelijke-ontwikkelingen/instrumenten-grondbeleid/kavelruil/' }],
            text: {
                name: 'Netherlands — voluntary urban land exchange (kavelruil)',
                note: 'Every party agrees. The exchange is then set down in a notarial deed and registered with the Kadaster; at least three parties take part.'
            }
        },
        {
            id: 'tw-owner-organized', version: CHECKED, family: 'support-and-authority', country: 'TW', stage: 'plan',
            tests: [test('headcount', 'owners', 'private', atLeast(1, 2)), test('area', 'owners', 'private', moreThan(1, 2))], authorities: 1,
            allocation: { basis: 'value', cap: { numerator: 45, denominator: 100, per: 'pool' } },
            sources: [{ label: 'Equalization of Land Rights Act, arts. 57–60', url: 'https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=D0060009' }],
            text: {
                name: 'Taiwan — owner-organized urban land readjustment',
                authority: 'approval by the competent authority',
                note: 'Counts private owners and private land only. Land for public facilities and costs may take at most 45% of the area (an exception procedure exists).'
            }
        },
        {
            id: 'kr-association', version: CHECKED, family: 'support-and-authority', country: 'KR', stage: 'association',
            tests: [test('area', 'owners', 'all', atLeast(2, 3)), test('headcount', 'owners', 'all', atLeast(1, 2))], authorities: 1,
            allocation: { basis: 'either' },
            sources: [{ label: 'Urban Development Act, art. 13 (effective 2026-07-01)', url: 'https://www.law.go.kr/lsLinkCommonInfo.do?lsJoLnkSeq=1029377027' }],
            text: {
                name: 'South Korea — urban development association',
                authority: 'the designating authority’s authorization of the association',
                note: 'These tests authorize forming the association; the replotting plan has its own later approval.'
            }
        },
        {
            id: 'es-ct-basic', version: CHECKED, family: 'support-and-authority', country: 'ES', region: 'CT', stage: 'initiative',
            tests: [test('area', 'owners', 'all', moreThan(1, 2))], authorities: 1,
            allocation: { basis: 'either' },
            sources: [{ label: 'Catalan urbanism law, art. 130', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2010-13883#a130' }],
            text: {
                name: 'Catalonia — basic compensation',
                authority: 'the municipality’s approval of the compensation project',
                note: 'Owners of more than half the area can start it; owners who do not join have defined roles.'
            }
        },
        {
            id: 'es-ct-concertacion', version: CHECKED, family: 'support-and-authority', country: 'ES', region: 'CT', stage: 'initiative',
            tests: [test('area', 'owners', 'all', moreThan(1, 4))], authorities: 1,
            allocation: { basis: 'either' },
            sources: [{ label: 'Catalan urbanism law, arts. 135–138', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2010-13883#a135' }],
            text: {
                name: 'Catalonia — compensation by agreement (concertación)',
                authority: 'the municipality’s selection and approval',
                note: 'Owners of more than a quarter of the area can start it; the municipality then runs a selection.'
            }
        },
        {
            id: 'es-md-compensation', version: CHECKED, family: 'support-and-authority', country: 'ES', region: 'MD', stage: 'initiative',
            tests: [test('area', 'owners', 'all', atLeast(1, 2))], authorities: 1,
            allocation: { basis: 'either' },
            sources: [{ label: 'Madrid land law, arts. 104–107', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2001-18984#a104' }],
            text: {
                name: 'Madrid — compensation by the owners',
                authority: 'the municipality’s approval',
                note: 'At least half the area: exactly half is enough here, unlike Catalonia.'
            }
        },
        {
            id: 'co-readjustment', version: CHECKED, family: 'support-and-authority', country: 'CO', stage: 'execution',
            tests: [test('area', 'owners', 'all', atLeast(51, 100))], authorities: 1,
            allocation: { basis: 'either' },
            sources: [{ label: 'Ley 388 de 1997, arts. 44–46', url: 'https://www1.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=339' }],
            text: {
                name: 'Colombia — urban action unit / land readjustment',
                authority: 'approval by the municipal planning authority',
                note: 'Owners of 51% of the committed area; the project also needs more than one participant.'
            }
        },
        {
            id: 'co-readjustment', version: CHECKED_VALUE, family: 'support-and-authority', country: 'CO', stage: 'execution',
            tests: [test('area', 'owners', 'all', atLeast(51, 100))], authorities: 1,
            allocation: { basis: 'either' }, minParties: 2,
            sources: [{ label: 'Ley 388 de 1997, arts. 44–46', url: 'https://www1.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=339' }],
            text: {
                name: 'Colombia — urban action unit / land readjustment',
                authority: 'approval by the municipal planning authority',
                note: 'Owners of 51% of the committed area; the project also needs more than one participant.'
            }
        },
        {
            id: 'jp-association', version: CHECKED, family: 'support-and-authority', country: 'JP', stage: 'association',
            tests: [
                test('headcount', 'owners', 'private', atLeast(2, 3)),
                test('headcount', 'leaseholders', 'private', atLeast(2, 3)),
                test('area', 'owners+leaseholders', 'private', atLeast(2, 3))
            ], authorities: 1,
            allocation: { basis: 'value' },
            sources: [
                { label: 'Land Readjustment Act, arts. 14 and 18', url: 'https://laws.e-gov.go.jp/law/329AC0000000119' },
                { label: 'Osaka prefecture review, p. 7', url: 'https://www.pref.osaka.lg.jp/documents/15513/0333_toushin0403.pdf' }
            ],
            text: {
                name: 'Japan — landowners’ association',
                authority: 'the prefectural governor’s approval',
                note: 'Three tests at once: owners, leaseholders, and owned plus leased area. Public land is outside them. Land is reallocated by value; reserve land can be sold to fund the works.'
            }
        },
        {
            id: 'jp-joint', version: CHECKED, family: 'support-and-authority', country: 'JP', stage: 'plan',
            tests: [test('headcount', 'owners', 'all', atLeast(1, 1)), test('headcount', 'leaseholders', 'all', atLeast(1, 1))], authorities: 1,
            allocation: { basis: 'value' },
            sources: [{ label: 'Land Readjustment Act, arts. 4 and 8', url: 'https://laws.e-gov.go.jp/law/329AC0000000119' }],
            text: {
                name: 'Japan — individual or joint implementation',
                authority: 'the prefectural governor’s approval of the plan',
                note: 'Every owner and leaseholder consents; some other rights are exempt.'
            }
        },
        {
            id: 'de-umlegung-new', version: CHECKED, family: 'authority-led', country: 'DE', stage: 'plan',
            tests: [], authorities: 1,
            allocation: { basis: 'either', cap: { numerator: 3, denominator: 10, per: 'owner', basis: 'area' } },
            sources: [
                { label: 'BauGB §§ 46–47', url: 'https://www.gesetze-im-internet.de/bbaug/__46.html' },
                { label: 'BauGB §§ 56–58', url: 'https://www.gesetze-im-internet.de/bbaug/__58.html' }
            ],
            text: {
                name: 'Germany — Umlegung, land developed for the first time',
                authority: 'the Umlegung authority’s adoption of the readjustment plan',
                note: 'No owner vote: the authority orders and decides, and owners are heard. Distributed by area, no owner gives up more than 30% of their land for public facilities (§58); by value, the gain is settled in money.'
            }
        },
        {
            id: 'de-umlegung-new', version: CHECKED_VALUE, family: 'authority-led', country: 'DE', stage: 'plan',
            tests: [], authorities: 1,
            allocation: { basis: 'either', cap: { numerator: 3, denominator: 10, per: 'owner', basis: 'area' }, valueGain: { numerator: 1, denominator: 1 } },
            sources: [
                { label: 'BauGB §§ 46–47', url: 'https://www.gesetze-im-internet.de/bbaug/__46.html' },
                { label: 'BauGB §§ 56–58', url: 'https://www.gesetze-im-internet.de/bbaug/__58.html' }
            ],
            text: {
                name: 'Germany — Umlegung, land developed for the first time',
                authority: 'the Umlegung authority’s adoption of the readjustment plan',
                note: 'No owner vote: the authority orders and decides, and owners are heard. Distributed by area, no owner gives up more than 30% of their land for public facilities (§58); by value, each owner is made whole to the value they put in and the whole gain is settled in money (§57).'
            }
        },
        {
            id: 'de-umlegung-developed', version: CHECKED, family: 'authority-led', country: 'DE', stage: 'plan',
            tests: [], authorities: 1,
            allocation: { basis: 'either', cap: { numerator: 1, denominator: 10, per: 'owner', basis: 'area' } },
            sources: [
                { label: 'BauGB §§ 46–47', url: 'https://www.gesetze-im-internet.de/bbaug/__46.html' },
                { label: 'BauGB §§ 56–58', url: 'https://www.gesetze-im-internet.de/bbaug/__58.html' }
            ],
            text: {
                name: 'Germany — Umlegung, already developed land',
                authority: 'the Umlegung authority’s decision on the readjustment plan',
                note: 'No owner vote: the authority orders and decides, and owners are heard. Distributed by area, no owner gives up more than 10% of their land (§58).'
            }
        },
        {
            id: 'de-umlegung-developed', version: CHECKED_VALUE, family: 'authority-led', country: 'DE', stage: 'plan',
            tests: [], authorities: 1,
            allocation: { basis: 'either', cap: { numerator: 1, denominator: 10, per: 'owner', basis: 'area' }, valueGain: { numerator: 1, denominator: 1 } },
            sources: [
                { label: 'BauGB §§ 46–47', url: 'https://www.gesetze-im-internet.de/bbaug/__46.html' },
                { label: 'BauGB §§ 56–58', url: 'https://www.gesetze-im-internet.de/bbaug/__58.html' }
            ],
            text: {
                name: 'Germany — Umlegung, already developed land',
                authority: 'the Umlegung authority’s decision on the readjustment plan',
                note: 'No owner vote: the authority orders and decides, and owners are heard. Distributed by area, no owner gives up more than 10% of their land (§58); by value, each owner is made whole to the value they put in and the whole gain is settled in money (§57).'
            }
        },
        {
            id: 'tr-article-18', version: CHECKED, family: 'authority-led', country: 'TR', stage: 'plan',
            tests: [], authorities: 1,
            allocation: { basis: 'area', cap: { numerator: 45, denominator: 100, per: 'owner' } },
            sources: [{ label: 'Zoning Law 3194, art. 18', url: 'https://webdosya.csb.gov.tr/v2/meslekihizmetler/2026/01/3194-Say-l-mar-Kanunu-20260114101544.pdf' }],
            text: {
                name: 'Turkey — article 18 readjustment',
                authority: 'the municipality’s decision on the parcellation plan',
                note: 'No owner consent is needed. Each holding gives up at most 45% of its area for public uses (DOP); the law applies it per parcel.'
            }
        },
        {
            id: 'in-gj-tps', version: CHECKED, family: 'authority-led', country: 'IN', region: 'GJ', stage: 'plan',
            tests: [], authorities: 1,
            allocation: { basis: 'value' },
            sources: [{ label: 'Gujarat Town Planning and Urban Development Act', url: 'https://www.indiacode.nic.in/bitstream/123456789/4658/1/tpudact.pdf' }],
            text: {
                name: 'India, Gujarat — town planning scheme',
                authority: 'the State government’s sanction of the scheme',
                note: 'The authority prepares the scheme and hears written objections; final plots are reconstituted by valuation.'
            }
        },
        {
            id: 'in-gj-tps', version: CHECKED_VALUE, family: 'authority-led', country: 'IN', region: 'GJ', stage: 'plan',
            tests: [], authorities: 1,
            allocation: { basis: 'value', valueGain: { numerator: 1, denominator: 2 } },
            sources: [
                { label: 'Gujarat Town Planning and Urban Development Act', url: 'https://www.indiacode.nic.in/bitstream/123456789/4658/1/tpudact.pdf' },
                { label: 'Surat TP scheme Form F (§79 contribution at 50% of the increment)', url: 'https://www.suratmunicipal.gov.in/Content/Documents/Departments/Draftschemes/TP23_KOSAD/TP23_KOSAD_FORM.pdf' }
            ],
            text: {
                name: 'India, Gujarat — town planning scheme',
                authority: 'the State government’s sanction of the scheme',
                note: 'The authority prepares the scheme and hears written objections; final plots are reconstituted by valuation, and each owner contributes half of their value increment towards the scheme’s costs (§§78–79).'
            }
        }
    ];

    const FAMILIES = ['voluntary', 'support-and-authority', 'authority-led'];
    const byKey = new Map(REGIMES.map(regime => [`${regime.id}@${regime.version}`, regime]));

    // What a new proposal can choose: the newest version of each scheme. Older versions stay
    // reachable through get() for the proposals that pinned them.
    function list() { return REGIMES.filter(regime => latest(regime.id) === regime); }
    function get(id, version) { return byKey.get(`${id}@${version}`) || null; }
    // The newest version of a scheme: what a new proposal pins.
    function latest(id) {
        return REGIMES.filter(regime => regime.id === id).sort((a, b) => (a.version < b.version ? 1 : -1))[0] || null;
    }

    // The policy a template prescribes, with the proposal's own abstract authority party ids.
    function policyOf(regime, authorityIds = []) {
        const ids = authorityIds.slice(0, regime.authorities);
        if (ids.length !== regime.authorities) throw new Error(`${regime.id} needs ${regime.authorities} authority id(s).`);
        return { type: 'rules', tests: regime.tests.map(row => ({ ...row })), authorities: ids.map(authorityId => ({ authorityId })) };
    }

    // What the rights file has to declare for these tests to count the right people.
    function needs(tests) {
        return {
            leases: tests.some(row => row.of !== 'owners'),
            publicBodies: tests.some(row => row.scope === 'private')
        };
    }

    const ratio = cap => cap.numerator / cap.denominator;
    // Tiny float slack so a plot drawn to exactly the cap is not reported over it.
    const SLACK = 1e-9;

    /**
     * A plan's distribution against a template's rules.
     * @param {object} regime a REGIMES entry
     * @param {{ basis: 'area'|'value', poolAreaM2: number|null,
     *   owners: { ownerKey: string, contributedAreaM2: number|null, assignedAreaM2: number }[],
     *   partyCount?: number, proposerAreaM2?: number }} facts
     *   owners are the input owners (not public land, open ground or outside recipients); partyCount is
     *   how many parties bring land in; proposerAreaM2 is the land a proposer acquires. A fact that is
     *   left out skips its rule.
     * @returns {{ ok: boolean, rules: object[] }} one entry per rule: { kind, ok, ... } with kind
     *   'basis', 'cap', 'parties' or 'proposer'.
     */
    function checkAllocation(regime, facts) {
        const rules = [];
        const allocation = regime?.allocation || {};
        if (allocation.basis === 'area' || allocation.basis === 'value') {
            rules.push({ kind: 'basis', required: allocation.basis, actual: facts.basis, ok: facts.basis === allocation.basis });
        }
        const cap = allocation.cap;
        if (cap && (!cap.basis || cap.basis === facts.basis)) {
            const limit = { numerator: cap.numerator, denominator: cap.denominator };
            if (cap.per === 'owner') {
                let worst = null;
                for (const owner of facts.owners || []) {
                    if (!(owner.contributedAreaM2 > 0)) continue;
                    const given = Math.max(0, owner.contributedAreaM2 - (owner.assignedAreaM2 || 0)) / owner.contributedAreaM2;
                    if (!worst || given > worst.given) worst = { ownerKey: owner.ownerKey, given };
                }
                rules.push({ kind: 'cap', per: 'owner', limit, worst, ok: !worst || worst.given <= ratio(cap) + SLACK });
            } else {
                const pool = facts.poolAreaM2;
                const kept = (facts.owners || []).reduce((sum, owner) => sum + (owner.assignedAreaM2 || 0), 0);
                const given = pool > 0 ? Math.max(0, pool - kept) / pool : null;
                rules.push({ kind: 'cap', per: 'pool', limit, given, ok: given !== null && given <= ratio(cap) + SLACK });
            }
        }
        if (regime?.minParties && typeof facts.partyCount === 'number') {
            rules.push({ kind: 'parties', required: regime.minParties, actual: facts.partyCount, ok: facts.partyCount >= regime.minParties });
        }
        // An authority-led readjustment returns the land to its owners or takes it for public use;
        // nobody else acquires land through it.
        if (regime?.family === 'authority-led' && typeof facts.proposerAreaM2 === 'number') {
            rules.push({ kind: 'proposer', areaM2: facts.proposerAreaM2, ok: !(facts.proposerAreaM2 > 0) });
        }
        return { ok: rules.every(rule => rule.ok), rules };
    }

    // The share of an owner's value gain the scheme settles in money (0 to 1): none without a scheme.
    function valueGainRatio(regime) {
        const gain = regime?.allocation?.valueGain;
        return gain ? gain.numerator / gain.denominator : 0;
    }

    return { CHECKED, CHECKED_VALUE, FAMILIES, REGIMES, list, get, latest, policyOf, needs, checkAllocation, valueGainRatio };
});
