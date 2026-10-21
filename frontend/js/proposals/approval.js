// Abstract parcel rights, approval context and the approval rule engine shared by all proposal tools.
// Uploaded declarations are data, not identity proof; authority evidence is supplied separately.
//
// Every scheme decides with the same parts (land-readjustmend.md §23):
// - parties: abstract holders of ownership or leasehold interests in the declared parcels, plus
//   any authority whose decision the rules require. All of them decide through the same signed,
//   lens-backed receipts; `ownerId` in rights, facts and receipts names such a party.
// - tests: owner-support conditions, each counting heads or area, of owners, leaseholders or both,
//   over all holders or private ones only (public bodies excluded), with an exact fraction;
// - authorities: decisions that must be given as well (or alone, for authority-led schemes).
// The stored policy is canonical: rules expressible as the older `unanimous` / `threshold` forms are
// stored in those forms, so existing proposals keep their hashes; anything else is `rules`.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApproval = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const RIGHTS_SCHEMA = 'parcel-rights/v1';
    // v2 adds leaseholds (`leases` per parcel) and `publicBodies`. A file using neither normalizes to
    // v1, so the same rights hash alike, and an older reader refuses a v2 file instead of dropping it.
    const RIGHTS_SCHEMA_V2 = 'parcel-rights/v2';
    const CONFIG_SCHEMA = 'proposal-approval/v1';
    const CONTEXT_SCHEMA = 'proposal-approval-context/v1';
    // The statement a party signs for one decision on one agreement (plan-design-agreement.md, M2).
    const DECISION_SCHEMA = 'agreement-decision/v1';
    const MAX_RECORDS = 10000;
    const MAX_TESTS = 8;
    const MAX_AUTHORITIES = 4;
    const MEASURES = ['headcount', 'area'];
    const CLASSES = ['owners', 'leaseholders', 'owners+leaseholders'];
    const SCOPES = ['all', 'private'];
    const crypto = () => root.__consentSha256
        || (typeof require === 'function' ? require('../../vendor/noble-hashes-1.8.0/sha256.js') : null);
    const regimes = () => root.ProposalApprovalRegimes
        || (typeof require === 'function' ? require('./approval-regimes.js') : null);
    const cid = () => {
        const api = root.Cid || (typeof require === 'function' ? require('../cid.js') : null);
        if (!api) throw new Error('Cid (js/cid.js) is not loaded.');
        return api;
    };
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    const unique = list => [...new Set(list)].sort(compare);
    function fail(message) {
        const error = new Error(message);
        error.code = 'invalid-proposal-approval';
        throw error;
    }
    function text(value, field) {
        if (typeof value !== 'string' || !value.trim() || value.length > 256) fail(`${field} needs a non-empty reference (maximum 256 characters).`);
        return value.trim();
    }
    function ownerId(value) {
        const id = text(value, 'ownerId');
        if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(id) || ['constructor', 'prototype', '__proto__'].includes(id)) fail('ownerId must be an opaque ID using letters, digits, or . _ : @ / - .');
        return id;
    }
    const gcd = (a, b) => b ? gcd(b, a % b) : a;
    const ZERO = { n: 0n, d: 1n };
    function reduce(n, d) {
        const divisor = gcd(n < 0n ? -n : n, d) || 1n;
        return { n: n / divisor, d: d / divisor };
    }
    function fraction(value) {
        if (typeof value !== 'string' || !/^\d{1,12}\/\d{1,12}$/.test(value)) fail('A share must be an exact fraction, such as 1/2.');
        const [n, d] = value.split('/').map(BigInt);
        if (d <= 0n || n <= 0n || n > d) fail('Ownership shares must be positive and at most 1/1.');
        return reduce(n, d);
    }
    const add = (a, b) => reduce(a.n * b.d + b.n * a.d, a.d * b.d);
    const multiply = (a, b) => reduce(a.n * b.n, a.d * b.d);
    const toNumber = value => Number(value.n) / Number(value.d);
    function area(value, field) {
        const areaM2 = value ?? null;
        if (areaM2 !== null && (typeof areaM2 !== 'number' || !Number.isFinite(areaM2) || areaM2 <= 0 || areaM2 > 1e15)) {
            fail(`${field} needs a positive finite area or null.`);
        }
        return areaM2;
    }
    // A list of holders with exact shares: an owner list, or the holders of one lease.
    function holders(list, where, complete, counter) {
        if ((counter.count += list.length) > MAX_RECORDS) fail('Too many ownership interests.');
        let sum = ZERO;
        const seen = new Set();
        const rows = list.map(holder => {
            const id = ownerId(holder?.ownerId);
            if (seen.has(id)) fail(`Duplicate owner ${id} on ${where}.`);
            seen.add(id);
            if (holder.kind != null && holder.kind !== 'ownership') fail(`${where}: list leaseholds under the parcel's leases (${RIGHTS_SCHEMA_V2}).`);
            const share = fraction(holder.share);
            sum = add(sum, share);
            return { ownerId: id, share: `${share.n}/${share.d}` };
        }).sort((a, b) => compare(a.ownerId, b.ownerId));
        if (sum.n > sum.d || (complete && (!rows.length || sum.n !== sum.d))) {
            fail(`${counter.noun || 'Shares'} for ${where} must ${complete ? 'sum to' : 'not exceed'} 1/1.`);
        }
        return rows;
    }
    function normalizeRights(raw) {
        if (!raw || ![RIGHTS_SCHEMA, RIGHTS_SCHEMA_V2].includes(raw.schema)) fail(`Expected ${RIGHTS_SCHEMA} or ${RIGHTS_SCHEMA_V2}.`);
        const v2 = raw.schema === RIGHTS_SCHEMA_V2;
        if (!raw.source || typeof raw.source !== 'object') fail('Rights need a source provider.');
        const source = { provider: text(raw.source.provider, 'source.provider') };
        if (raw.source.reference != null && raw.source.reference !== '') source.reference = text(raw.source.reference, 'source.reference');
        if (!Array.isArray(raw.parcels) || raw.parcels.length > MAX_RECORDS) fail('Rights need a bounded parcel list.');
        const seen = new Set();
        const counter = { count: 0 };
        const parcels = raw.parcels.map(parcel => {
            const parcelId = text(parcel?.parcelId, 'parcelId');
            if (seen.has(parcelId)) fail(`Duplicate parcel ${parcelId}.`);
            seen.add(parcelId);
            if (typeof parcel.complete !== 'boolean') fail(`Parcel ${parcelId} must declare whether its owner list is complete.`);
            if (!Array.isArray(parcel.owners)) fail(`Parcel ${parcelId} needs an owners array.`);
            const owners = holders(parcel.owners, parcelId, parcel.complete, Object.assign(counter, { noun: 'Ownership shares' }));
            const areaM2 = area(parcel.areaM2, `Parcel ${parcelId}`);
            if (parcel.leases == null) return { parcelId, complete: parcel.complete, areaM2, owners };
            if (!v2) fail(`Leaseholds need ${RIGHTS_SCHEMA_V2}.`);
            if (!Array.isArray(parcel.leases) || parcel.leases.length > 100) fail(`Parcel ${parcelId} needs a bounded leases list.`);
            const leaseIds = new Set();
            // A parcel's `complete` covers its leases too: every lease is listed, with all holders.
            const leases = parcel.leases.map(lease => {
                const leaseId = text(lease?.leaseId, 'leaseId');
                if (leaseIds.has(leaseId)) fail(`Duplicate lease ${leaseId} on ${parcelId}.`);
                leaseIds.add(leaseId);
                if (!Array.isArray(lease.holders) || !lease.holders.length) fail(`Lease ${leaseId} on ${parcelId} needs its holders.`);
                const leaseArea = area(lease.areaM2, `Lease ${leaseId} on ${parcelId}`);
                if (leaseArea !== null && areaM2 !== null && leaseArea > areaM2) fail(`Lease ${leaseId} covers more than parcel ${parcelId}.`);
                return { leaseId, areaM2: leaseArea, holders: holders(lease.holders, `lease ${leaseId} on ${parcelId}`, parcel.complete, Object.assign(counter, { noun: 'Lease shares' })) };
            }).sort((a, b) => compare(a.leaseId, b.leaseId));
            return leases.length ? { parcelId, complete: parcel.complete, areaM2, owners, leases } : { parcelId, complete: parcel.complete, areaM2, owners };
        }).sort((a, b) => compare(a.parcelId, b.parcelId));
        let publicBodies = [];
        if (raw.publicBodies != null) {
            if (!v2) fail(`Public bodies need ${RIGHTS_SCHEMA_V2}.`);
            if (!Array.isArray(raw.publicBodies) || raw.publicBodies.length > MAX_RECORDS) fail('publicBodies must be a bounded list.');
            const held = new Set(parcels.flatMap(parcel => [...parcel.owners, ...(parcel.leases || []).flatMap(lease => lease.holders)].map(row => row.ownerId)));
            publicBodies = raw.publicBodies.map(ownerId);
            if (new Set(publicBodies).size !== publicBodies.length) fail('publicBodies lists a party twice.');
            const stray = publicBodies.find(id => !held.has(id));
            if (stray) fail(`Public body ${stray} holds no right in this file.`);
            publicBodies.sort(compare);
        }
        const usesV2 = publicBodies.length > 0 || parcels.some(parcel => parcel.leases);
        return usesV2 ? { schema: RIGHTS_SCHEMA_V2, source, parcels, ...(publicBodies.length ? { publicBodies } : {}) }
            : { schema: RIGHTS_SCHEMA, source, parcels };
    }
    function threshold(raw) {
        if (!raw || !Number.isSafeInteger(raw.numerator) || !Number.isSafeInteger(raw.denominator)
            || raw.numerator <= 0 || raw.denominator <= 0 || raw.numerator > raw.denominator
            || raw.denominator > 1e12 || typeof raw.strict !== 'boolean'
            || (raw.strict && raw.numerator === raw.denominator)) fail('Invalid owner/area threshold.');
        const divisor = Number(gcd(BigInt(raw.numerator), BigInt(raw.denominator)));
        return { numerator: raw.numerator / divisor, denominator: raw.denominator / divisor, strict: raw.strict };
    }
    const UNANIMOUS_TEST = { measure: 'headcount', of: 'owners', scope: 'all', numerator: 1, denominator: 1, strict: false };
    const testKey = test => `${test.measure}:${test.of}:${test.scope}`;
    function testOf(raw) {
        if (!raw || !MEASURES.includes(raw.measure) || !CLASSES.includes(raw.of)) fail('Each approval test counts heads or area, of owners, leaseholders or both.');
        const scope = raw.scope == null ? 'all' : raw.scope;
        if (!SCOPES.includes(scope)) fail('An approval test counts all holders or private holders only.');
        return { measure: raw.measure, of: raw.of, scope, ...threshold(raw) };
    }
    function sortedTests(list) {
        if (!Array.isArray(list) || list.length > MAX_TESTS) fail(`Use at most ${MAX_TESTS} approval tests.`);
        const tests = list.map(testOf).sort((a, b) => compare(testKey(a), testKey(b)));
        tests.forEach((test, index) => { if (index && testKey(tests[index - 1]) === testKey(test)) fail('Two approval tests count the same thing.'); });
        return tests;
    }
    // Any stored or authored policy as its tests and required authority decisions.
    function policyRules(raw) {
        if (!raw || raw.type === 'unanimous') return { tests: [{ ...UNANIMOUS_TEST }], authorities: [] };
        if (raw.type === 'threshold') {
            if (raw.owners == null && raw.area == null) fail('A threshold needs an owner-count or an area test.');
            return { tests: sortedTests([
                ...(raw.owners != null ? [{ measure: 'headcount', of: 'owners', scope: 'all', ...threshold(raw.owners) }] : []),
                ...(raw.area != null ? [{ measure: 'area', of: 'owners', scope: 'all', ...threshold(raw.area) }] : [])
            ]), authorities: [] };
        }
        if (raw.type !== 'rules') fail('Unknown approval policy.');
        const tests = sortedTests(raw.tests || []);
        const list = raw.authorities || [];
        if (!Array.isArray(list) || list.length > MAX_AUTHORITIES) fail(`Use at most ${MAX_AUTHORITIES} authority decisions.`);
        const authorities = unique(list.map(row => ownerId(row?.authorityId))).map(authorityId => ({ authorityId }));
        if (authorities.length !== list.length) fail('An authority is named twice.');
        if (!tests.length && !authorities.length) fail('The rules need an owner test or an authority decision.');
        return { tests, authorities };
    }
    const sameTest = (a, b) => testKey(a) === testKey(b) && a.numerator === b.numerator && a.denominator === b.denominator && a.strict === b.strict;
    const rule = test => ({ numerator: test.numerator, denominator: test.denominator, strict: test.strict });
    // The canonical stored form of a set of rules (see the header).
    function compact({ tests, authorities }) {
        if (!authorities.length) {
            if (tests.length === 1 && sameTest(tests[0], UNANIMOUS_TEST)) return { type: 'unanimous' };
            if (tests.every(test => test.of === 'owners' && test.scope === 'all')) {
                const owners = tests.find(test => test.measure === 'headcount');
                const area = tests.find(test => test.measure === 'area');
                return { type: 'threshold', ...(owners ? { owners: rule(owners) } : {}), ...(area ? { area: rule(area) } : {}) };
            }
        }
        return { type: 'rules', tests, authorities };
    }
    const normalizePolicy = raw => compact(policyRules(raw));
    // A named scheme (approval-regimes.js) pins its id and version; its tests and authority count
    // must be exactly the template's, so the label never names rules it does not have.
    function normalizeRegime(raw, policy) {
        if (raw == null) return null;
        const id = text(raw.id, 'regime.id'), version = text(raw.version, 'regime.version');
        const template = regimes()?.get(id, version);
        if (!template) fail(`Unknown agreement rules ${id} (${version}).`);
        const rules = policyRules(policy);
        const expected = sortedTests(template.tests);
        if (rules.authorities.length !== template.authorities || rules.tests.length !== expected.length
            || rules.tests.some((test, index) => !sameTest(test, expected[index]))) {
            fail(`The approval rule is not ${id} (${version}); choose Custom rules to change it.`);
        }
        return { id, version };
    }
    function normalizeConfig(raw) {
        if (!raw || raw.schema !== CONFIG_SCHEMA) fail(`Expected ${CONFIG_SCHEMA}.`);
        const policy = normalizePolicy(raw.policy);
        const regime = normalizeRegime(raw.regime, policy);
        return { schema: CONFIG_SCHEMA, rights: raw.rights == null ? null : normalizeRights(raw.rights), policy, ...(regime ? { regime } : {}) };
    }
    function lensKeys(proposal) {
        const rows = proposal?.lens || [];
        if (!Array.isArray(rows)) fail('The proposal lens must be a list.');
        return [...new Set(rows.filter(row => typeof row === 'string' || row?.address || row?.key)
            .map(row => text(typeof row === 'string' ? row : row.address || row.key, 'lens member')))].sort(compare);
    }
    function contextContent(proposal) {
        const config = proposal?.approvalConfig == null
            ? { rights: null, policy: { type: 'unanimous' } } : normalizeConfig(proposal.approvalConfig);
        return {
            schema: CONTEXT_SCHEMA,
            cadastreParcelIds: [...new Set((proposal?.cadastreParcelIds || []).map(id => text(String(id), 'parcelId')))].sort(compare),
            rights: config.rights, policy: config.policy, ...(config.regime ? { regime: config.regime } : {}), lens: lensKeys(proposal)
        };
    }
    function stableStringify(value) {
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
        return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
    }
    const hash = (prefix, value) => prefix + crypto().sha256Hex(stableStringify(value));
    const contextHash = proposal => hash('approval1-sha256:', contextContent(proposal));
    function inspect(proposal) {
        const context = contextContent(proposal);
        const rules = policyRules(context.policy);
        const byParcel = new Map((context.rights?.parcels || []).map(parcel => [parcel.parcelId, parcel]));
        const parcels = context.cadastreParcelIds.map(id => byParcel.get(id)).filter(Boolean);
        const missingParcelIds = context.cadastreParcelIds.filter(id => !byParcel.get(id)?.complete);
        const ownerIds = unique(parcels.flatMap(parcel => parcel.owners.map(owner => owner.ownerId)));
        const leaseholderIds = unique(parcels.flatMap(parcel => (parcel.leases || []).flatMap(lease => lease.holders.map(holder => holder.ownerId))));
        const holderIds = new Set([...ownerIds, ...leaseholderIds]);
        const authorityIds = rules.authorities.map(row => row.authorityId);
        const publicIds = (context.rights?.publicBodies || []).filter(id => holderIds.has(id));
        const reason = !context.rights ? 'missing-rights' : !context.cadastreParcelIds.length ? 'missing-parcels'
            : missingParcelIds.length ? 'incomplete-rights' : !ownerIds.length ? 'missing-owners'
                : authorityIds.some(id => holderIds.has(id)) ? 'authority-is-holder' : null;
        return {
            ready: !reason, reason, ownerIds, leaseholderIds, authorityIds, publicIds,
            partyIds: unique([...holderIds, ...authorityIds]), parcels, missingParcelIds, context, rules
        };
    }
    // "A", "B", … "Z", "AA" for a 1-based position.
    function letters(position) {
        let number = position, label = '';
        while (number) { number -= 1; label = String.fromCharCode(65 + number % 26) + label; number = Math.floor(number / 26); }
        return label;
    }
    function ownerLabel(id, ids) {
        const number = ids.indexOf(id) + 1;
        return number ? `Owner ${letters(number)}` : 'Owner';
    }
    // What a party is in this proposal and its English label: owners are "Owner A…", holders of a
    // lease only "Leaseholder A…", required authorities "Authority" (or "Authority A…").
    function partyOf(id, state) {
        if (state.authorityIds.includes(id)) {
            return { kind: 'authority', letter: state.authorityIds.length > 1 ? letters(state.authorityIds.indexOf(id) + 1) : '' };
        }
        if (state.ownerIds.includes(id)) return { kind: 'owner', letter: letters(state.ownerIds.indexOf(id) + 1) };
        const leaseOnly = state.leaseholderIds.filter(holder => !state.ownerIds.includes(holder));
        return leaseOnly.includes(id) ? { kind: 'leaseholder', letter: letters(leaseOnly.indexOf(id) + 1) } : null;
    }
    function partyLabel(id, state) {
        const party = partyOf(id, state);
        if (!party) return 'Owner';
        return party.kind === 'authority' ? `Authority${party.letter ? ` ${party.letter}` : ''}`
            : `${party.kind === 'owner' ? 'Owner' : 'Leaseholder'} ${party.letter}`;
    }
    function createTemplate(parcelIds = [], { leases = false, publicBodies = false } = {}) {
        const v2 = leases || publicBodies;
        return {
            schema: v2 ? RIGHTS_SCHEMA_V2 : RIGHTS_SCHEMA, source: { provider: 'upload', reference: 'rights-snapshot-1' },
            parcels: [...new Set(parcelIds.map(String))].map(parcelId => ({ parcelId, complete: false, areaM2: null, owners: [], ...(leases ? { leases: [] } : {}) })),
            ...(publicBodies ? { publicBodies: [] } : {})
        };
    }
    // Numbers are converted to their exact decimal representation for threshold comparisons.
    // This avoids an arbitrary epsilon allowing an exactly-50% strict-majority vote to pass.
    function decimal(value) {
        const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
        const [whole, fractional = ''] = mantissa.split('.');
        const shift = Number(exponent) - fractional.length;
        const n = BigInt(whole + fractional);
        return shift >= 0 ? { n: n * 10n ** BigInt(shift), d: 1n } : { n, d: 10n ** BigInt(-shift) };
    }
    function passes(yes, total, test) {
        const left = yes.n * total.d * BigInt(test.denominator);
        const right = total.n * yes.d * BigInt(test.numerator);
        return test.strict ? left > right : left >= right;
    }
    // The least support that meets a test: a whole number of heads, or an area ("more than" when strict).
    function needed(test, total) {
        if (test.measure === 'headcount') {
            const product = total.n * BigInt(test.numerator), denominator = total.d * BigInt(test.denominator);
            return Number(test.strict ? product / denominator + 1n : (product + denominator - 1n) / denominator);
        }
        return toNumber(multiply(total, reduce(BigInt(test.numerator), BigInt(test.denominator))));
    }
    // One test over the parties' approvals. Heads are distinct parties; area is each parcel's (or
    // lease's) area times the counted holders' shares, and counts only once all of them approved.
    // An empty electorate (no leaseholders, say) does not block: the test is met and marked vacuous.
    function evaluate(test, state, yes) {
        const publicIds = new Set(state.publicIds);
        const counted = id => test.scope === 'all' || !publicIds.has(id);
        let support = ZERO, total = ZERO, known = true;
        if (test.measure === 'headcount') {
            const pool = test.of === 'owners' ? state.ownerIds : test.of === 'leaseholders' ? state.leaseholderIds
                : unique([...state.ownerIds, ...state.leaseholderIds]);
            const electorate = pool.filter(counted);
            total = { n: BigInt(electorate.length), d: 1n };
            support = { n: BigInt(electorate.filter(id => yes.has(id)).length), d: 1n };
        } else {
            const units = [
                ...(test.of !== 'leaseholders' ? state.parcels.map(parcel => ({ areaM2: parcel.areaM2, holders: parcel.owners })) : []),
                ...(test.of !== 'owners' ? state.parcels.flatMap(parcel => (parcel.leases || [])
                    .map(lease => ({ areaM2: lease.areaM2 ?? parcel.areaM2, holders: lease.holders }))) : [])
            ];
            for (const unit of units) {
                const voters = unit.holders.filter(holder => counted(holder.ownerId));
                if (!voters.length) continue;
                if (unit.areaM2 === null) { known = false; continue; }
                const weight = multiply(decimal(unit.areaM2), voters.reduce((sum, holder) => add(sum, fraction(holder.share)), ZERO));
                total = add(total, weight);
                if (voters.every(holder => yes.has(holder.ownerId))) support = add(support, weight);
            }
        }
        const vacuous = known && total.n === 0n;
        return {
            measure: test.measure, of: test.of, scope: test.scope, numerator: test.numerator, denominator: test.denominator, strict: test.strict,
            known, vacuous, support: known ? toNumber(support) : null, total: known ? toNumber(total) : null,
            needed: known && !vacuous ? needed(test, total) : null,
            met: known && (vacuous || passes(support, total, test))
        };
    }
    function tally(proposal, approvedIds = []) {
        const state = inspect(proposal);
        const yes = new Set(approvedIds.filter(id => state.partyIds.includes(id)));
        const ready = state.ready;
        const acceptedParcelIds = ready ? state.parcels.filter(parcel => parcel.owners.every(owner => yes.has(owner.ownerId))).map(parcel => parcel.parcelId) : [];
        const tests = ready ? state.rules.tests.map(test => evaluate(test, state, yes)) : [];
        const authorities = state.rules.authorities.map(({ authorityId }) => ({ authorityId, approved: ready && yes.has(authorityId) }));
        // Owners and the land they hold, whatever the rules count: the figures other views show.
        const ownership = ready ? evaluate({ ...UNANIMOUS_TEST, measure: 'area' }, state, yes) : null;
        const supportMet = ready && tests.every(test => test.met);
        const authorityMet = ready && authorities.every(row => row.approved);
        return {
            ready, reason: state.reason, tests, authorities, supportMet, authorityMet, passed: supportMet && authorityMet,
            totalOwners: ready ? state.ownerIds.length : null, acceptedOwners: ready ? state.ownerIds.filter(id => yes.has(id)).length : 0,
            acceptedParcelIds,
            totalAreaM2: ownership?.known ? ownership.total : null,
            acceptedAreaM2: ownership?.known ? ownership.support : null
        };
    }
    function evidenceAllows(proposal, owner, actorId, evidence) {
        const state = inspect(proposal);
        if (!state.ready || !state.partyIds.includes(owner) || !actorId || !evidence) return false;
        const expected = contextHash(proposal);
        return ['rights', 'authority'].every(kind => {
            const fact = evidence[kind];
            return fact && fact.contextHash === expected && state.context.lens.includes(fact.member)
                && typeof fact.evidenceRef === 'string' && !!fact.evidenceRef
                && (kind === 'rights' || (fact.ownerId === owner && fact.actorId === actorId));
        });
    }
    // Decisions are taken on an agreement (plan-design-agreement.md, M2). The functions below take an
    // agreement-like object: the engine's subject { cadastreParcelIds, approvalConfig, lens } (the
    // agreement's AgreementRecord.approvalSubject) plus `agreementCid`, its published CID, and the
    // receipts `ownerApprovals` (ownerId → receipt) and `ownerApprovalHistory`. A receipt is
    // { ownerId, actorId, evidence: { rights, authority }, decision: 'approve' | 'withdraw',
    // decidedAt, decisionProof, providerId }; it carries no terms hash, because the CID it signs
    // commits to the designs, land, allocations, money and rule.
    // The identity a decision signs: the agreement's CID.
    function subjectOf(agreement) {
        const subject = agreement?.agreementCid;
        if (!cid().isCid(subject)) fail('A decision needs a published agreement: its agreementCid is not a CID.');
        return subject;
    }
    function decisionContent(agreement, receipt) {
        return { schema: DECISION_SCHEMA, agreementCid: subjectOf(agreement),
            ownerId: receipt.ownerId, actorId: receipt.actorId, contextHash: contextHash(agreement),
            decision: receipt.decision, decidedAt: receipt.decidedAt };
    }
    // Every party (owner, leaseholder or authority) whose current approval of this agreement verifies.
    // An agreement without a CID (an unproposed draft) has none.
    function validOwnerIds(agreement, verifyReceipt) {
        const state = inspect(agreement);
        if (!state.ready || !cid().isCid(agreement?.agreementCid) || typeof verifyReceipt !== 'function') return [];
        return state.partyIds.filter(id => {
            const receipt = agreement.ownerApprovals?.[id];
            return receipt?.ownerId === id && receipt.decision === 'approve'
                && evidenceAllows(agreement, id, receipt.actorId, receipt.evidence)
                && verifyReceipt(agreement, receipt) === true;
        });
    }
    function recordDecision(agreement, { ownerId: id, actorId, evidence, decidedAt, withdraw = false, decisionProof, providerId, verifyReceipt }) {
        subjectOf(agreement);
        if (!evidenceAllows(agreement, id, actorId, evidence)) fail('The selected lens has not established these rights and this actor’s authority.');
        const receipt = { ownerId: id, actorId, evidence: JSON.parse(JSON.stringify(evidence)), decidedAt,
            decision: withdraw ? 'withdraw' : 'approve', decisionProof, providerId };
        if (typeof decidedAt !== 'string' || !Number.isFinite(Date.parse(decidedAt))
            || typeof verifyReceipt !== 'function' || verifyReceipt(agreement, receipt) !== true) fail('The owner decision has not been verified.');
        const next = JSON.parse(JSON.stringify(agreement));
        const previous = next.ownerApprovals?.[id];
        if (withdraw && (!previous || previous.actorId !== actorId)) fail('Only the actor who recorded an approval may withdraw it.');
        if (!withdraw && validOwnerIds(next, verifyReceipt).includes(id)) fail('This owner has already approved this agreement.');
        next.ownerApprovals = next.ownerApprovals || {};
        if (previous) next.ownerApprovalHistory = [...(next.ownerApprovalHistory || []), previous];
        if (withdraw) {
            delete next.ownerApprovals[id];
            next.ownerApprovalHistory = [...(next.ownerApprovalHistory || []), receipt];
        } else next.ownerApprovals[id] = receipt;
        const result = tally(next, validOwnerIds(next, verifyReceipt));
        next.acceptedParcelIds = result.acceptedParcelIds;
        return { agreement: next, tally: result };
    }
    return { RIGHTS_SCHEMA, RIGHTS_SCHEMA_V2, CONFIG_SCHEMA, CONTEXT_SCHEMA, DECISION_SCHEMA, MEASURES, CLASSES, SCOPES, MAX_TESTS, MAX_AUTHORITIES,
        normalizeRights, normalizeConfig, normalizePolicy, policyRules, testOf,
        lensKeys, contextContent, contextHash, stableStringify, inspect, ownerLabel, partyOf, partyLabel, letters, createTemplate,
        tally, evidenceAllows, subjectOf, decisionContent, validOwnerIds, recordDecision };
});
