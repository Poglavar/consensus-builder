// Agreement rules of real readjustment schemes on one engine (land-readjustmend.md §23): rights with
// leases and public bodies, tests over owners/leaseholders/private holders, required authority
// decisions, scheme templates pinned by version, distribution caps, the lens member attesting all
// of it, and an authority's signed decision counted like an owner's. Proposals published before
// schemes keep their hashes.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Keypair } from '@solana/web3.js';
import * as turf from '@turf/turf';
import { createApprovalAttester, fileRegistry, normalizeRegistry } from '../lens/approval.js';
import { wallet, MEMBER, memberKeypair, NOW, at } from './helpers/approval-decisions.js';
import { cidOf } from '../cid.js';

const require = createRequire(import.meta.url);
const A = require('../../frontend/js/proposals/approval.js');
const R = require('../../frontend/js/proposals/approval-regimes.js');
const X = require('../../frontend/js/proposals/approval-text.js');
const review = require('../../frontend/js/proposals/approval-review.js');
const relay = require('../../frontend/js/proposals/approval-relay.js');
const proof = require('../../frontend/js/proposals/approval-proof.js');
const validation = require('../../frontend/js/reparcellization-validation.js');
const approvalPanelSource = readFileSync(new URL('../../frontend/js/proposals/approval-panel.js', import.meta.url), 'utf8');
const approval = require('../../frontend/js/proposals/approval.js');
const approvalRegimes = require('../../frontend/js/proposals/approval-regimes.js');
const approvalReview = require('../../frontend/js/proposals/approval-review.js');
const approvalText = require('../../frontend/js/proposals/approval-text.js');
const format = require('../../frontend/js/format.js');
const escape = require('../../frontend/js/shared-utils.js').escapeHtml;

function loadApprovalPanel() {
    const window = {
        ProposalApproval: approval,
        ProposalApprovalRegimes: approvalRegimes,
        ProposalApprovalReview: approvalReview,
        ProposalApprovalRuntime: {
            inspect: approval.inspect,
            validIds: () => [],
            label: (id, rights) => approval.partyLabel(id, rights)
        },
        ProposalApprovalText: approvalText,
        ProposalApprovalLensAuthority: { browserWallet: () => null },
        solanaWalletManager: { on() {} },
        CbFormat: format,
        addEventListener() {}, removeEventListener() {}
    };
    const context = vm.createContext({
        window, console, Date, Math, Number, String, Array, Object, Set, Map, Promise,
        escapeHtml: escape,
        getProposalI18nHelper: () => (_key, fallback, params = {}) => String(fallback).replace(/\{\{(\w+)\}\}/g, (_, name) => params[name] ?? ''),
        getCurrentUserAgent: () => null,
        getParcelDisplayNumberFromProperties: (_properties, id) => id,
        ProposalDisplayText: { parcelLabel: value => value },
        LiveParcelFabric: { get: () => null }, CadastralParcelRepository: { get: () => null }
    });
    vm.runInNewContext(approvalPanelSource, context, { filename: 'approval-panel.js' });
    return window.ProposalApprovalPanel;
}

const t = (key, fallback, params = {}) => String(fallback).replace(/\{\{(\w+)\}\}/g, (_, name) => params[name]);
const owner = (ownerId, share = '1/1') => ({ ownerId, share });
const v1 = parcels => ({ schema: 'parcel-rights/v1', source: { provider: 'upload', reference: 's1' }, parcels });
const v2 = (parcels, extra = {}) => ({ schema: 'parcel-rights/v2', source: { provider: 'upload', reference: 's1' }, parcels, ...extra });
const config = (rights, policy, regime) => ({ schema: 'proposal-approval/v1', rights, policy, ...(regime ? { regime } : {}) });
const proposal = (rights, policy, regime = null, ids = null) => ({
    proposalId: 'regime-test', cadastreParcelIds: ids || rights.parcels.map(p => p.parcelId), approvalConfig: config(rights, policy, regime), lens: ['member-1']
});
const threshold = (owners, area) => ({ type: 'threshold', ...(owners ? { owners: { numerator: owners[0], denominator: owners[1], strict: !!owners[2] } } : {}),
    ...(area ? { area: { numerator: area[0], denominator: area[1], strict: !!area[2] } } : {}) });
const rules = (tests, authorities = []) => ({ type: 'rules', tests, authorities: authorities.map(authorityId => ({ authorityId })) });
const test = (measure, of, scope, numerator, denominator, strict = false) => ({ measure, of, scope, numerator, denominator, strict });
const pin = id => ({ id, version: R.latest(id).version });
const testsOf = tally => tally.tests.map(row => [`${row.measure}/${row.of}/${row.scope}`, row.support, row.total, row.met]);

describe('approval card area meters', () => {
    const subject = policy => ({
        agreementId: 'missing-area-card', cadastreParcelIds: ['parcel-1'],
        approvalConfig: config(v1([{ parcelId: 'parcel-1', complete: true, areaM2: null, owners: [owner('owner-1')] }]), policy),
        ownerApprovals: {}, ownerApprovalHistory: []
    });
    const card = policy => loadApprovalPanel().cardHtml(subject(policy));

    it('does not show an unresolved-area warning for unanimous or head-count rules', () => {
        expect(card({ type: 'unanimous' })).not.toContain('Parcel areas are unresolved.');
        expect(card(threshold([1, 1], null))).not.toContain('Parcel areas are unresolved.');
    });

    it('keeps the unresolved-area warning when a threshold counts area', () => {
        expect(card(threshold(null, [1, 2]))).toContain('Parcel areas are unresolved.');
    });
});

// Owners A, B; C and D co-own c; the city owns d; tenant T leases 100 of a's 300 m².
const parcels = [
    { parcelId: 'a', complete: true, areaM2: 300, owners: [owner('o-a')], leases: [{ leaseId: 'L1', areaM2: 100, holders: [owner('t-1')] }] },
    { parcelId: 'b', complete: true, areaM2: 200, owners: [owner('o-b')] },
    { parcelId: 'c', complete: true, areaM2: 100, owners: [owner('o-c', '1/2'), owner('o-d', '1/2')] },
    { parcelId: 'd', complete: true, areaM2: 400, owners: [owner('city')] }
];
const mixed = v2(parcels, { publicBodies: ['city'] });

describe('rights with leases and public bodies', () => {
    it('normalizes leases and public bodies under v2, and refuses them under v1', () => {
        const rights = A.normalizeRights(mixed);
        expect(rights.schema).toBe('parcel-rights/v2');
        expect(rights.publicBodies).toEqual(['city']);
        expect(rights.parcels[0].leases).toEqual([{ leaseId: 'L1', areaM2: 100, holders: [{ ownerId: 't-1', share: '1/1' }] }]);
        expect(rights.parcels[1].leases).toBeUndefined();
        expect(() => A.normalizeRights({ ...mixed, schema: 'parcel-rights/v1' })).toThrow(/parcel-rights\/v2/);
        expect(() => A.normalizeRights(v2(parcels.slice(1), { publicBodies: ['nobody'] }))).toThrow(/holds no right/);
        expect(() => A.normalizeRights(v2([{ ...parcels[0], leases: [{ leaseId: 'L1', areaM2: 301, holders: [owner('t-1')] }] }]))).toThrow(/covers more than/);
        expect(() => A.normalizeRights(v2([{ ...parcels[0], leases: [{ leaseId: 'L1', holders: [owner('t-1', '1/2')] }] }]))).toThrow(/Lease shares .* sum to/);
        expect(() => A.normalizeRights(v1([{ ...parcels[1], owners: [{ ownerId: 'x', share: '1/1', kind: 'lease' }] }]))).toThrow(/leases/);
    });

    it('stores a v2 file that uses neither as v1, so the rights hash alike', () => {
        const plain = parcels.slice(1, 3);
        expect(A.normalizeRights(v2(plain))).toEqual(A.normalizeRights(v1(plain)));
    });

    it('tells owners, leaseholders, public bodies and authorities apart, and refuses an authority that holds a right', () => {
        const state = A.inspect(proposal(mixed, rules([test('headcount', 'owners', 'private', 1, 2)], ['planning-office'])));
        expect(state).toMatchObject({ ready: true, ownerIds: ['city', 'o-a', 'o-b', 'o-c', 'o-d'], leaseholderIds: ['t-1'], publicIds: ['city'],
            authorityIds: ['planning-office'], partyIds: ['city', 'o-a', 'o-b', 'o-c', 'o-d', 'planning-office', 't-1'] });
        expect(A.partyLabel('o-a', state)).toBe('Owner B');
        expect(A.partyLabel('t-1', state)).toBe('Leaseholder A');
        expect(A.partyLabel('planning-office', state)).toBe('Authority');
        expect(A.inspect(proposal(mixed, rules([], ['o-a']))).reason).toBe('authority-is-holder');
    });
});

// Every scheme version ever offered. A published proposal pins id@version, so removing or re-dating
// one would make those proposals' approval rules unreadable: a re-check adds a version, and this
// list only grows.
const SHIPPED = [
    ...['nl-kavelruil', 'tw-owner-organized', 'kr-association', 'es-ct-basic', 'es-ct-concertacion',
        'es-md-compensation', 'co-readjustment', 'jp-association', 'jp-joint', 'de-umlegung-new',
        'de-umlegung-developed', 'tr-article-18', 'in-gj-tps'].map(id => `${id}@2026-10-11`),
    // 2026-10-28: value-gain settlement (Germany, Gujarat) and party counts (kavelruil, Colombia).
    ...['nl-kavelruil', 'co-readjustment', 'de-umlegung-new', 'de-umlegung-developed', 'in-gj-tps'].map(id => `${id}@2026-10-28`)
];

describe('scheme versions', () => {
    it('keeps every shipped version resolvable, so pinned proposals still read', () => {
        for (const key of SHIPPED) {
            const [id, version] = key.split('@');
            expect(R.get(id, version), key).not.toBe(null);
            const policy = R.policyOf(R.get(id, version), R.get(id, version).authorities ? ['authority-1'] : []);
            expect(() => A.normalizeConfig(config(null, policy, { id, version })), key).not.toThrow();
        }
    });

    it('offers new proposals one entry per scheme, its newest version', () => {
        const ids = R.list().map(regime => regime.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const regime of R.list()) expect(R.latest(regime.id)).toBe(regime);
    });
});

describe('the canonical policy', () => {
    it('keeps the two older forms for rules they can express, so published proposals keep their hashes', () => {
        expect(A.normalizePolicy(rules([test('headcount', 'owners', 'all', 1, 1)]))).toEqual({ type: 'unanimous' });
        expect(A.normalizePolicy(rules([test('area', 'owners', 'all', 7, 10), test('headcount', 'owners', 'all', 2, 4)])))
            .toEqual({ type: 'threshold', owners: { numerator: 1, denominator: 2, strict: false }, area: { numerator: 7, denominator: 10, strict: false } });
        expect(A.normalizePolicy(rules([test('area', 'owners', 'all', 1, 2, true)]))).toEqual({ type: 'threshold', area: { numerator: 1, denominator: 2, strict: true } });
        expect(A.normalizePolicy(threshold([1, 2], null))).toEqual({ type: 'threshold', owners: { numerator: 1, denominator: 2, strict: false } });
        const japan = A.normalizePolicy(rules([test('headcount', 'leaseholders', 'private', 2, 3), test('headcount', 'owners', 'private', 2, 3)], ['governor']));
        expect(japan.type).toBe('rules');
        expect(japan.tests.map(row => row.of)).toEqual(['leaseholders', 'owners']);
        expect(() => A.normalizePolicy(rules([]))).toThrow(/owner test or an authority/);
        expect(() => A.normalizePolicy(rules([test('area', 'owners', 'all', 1, 2), test('area', 'owners', 'all', 2, 3)]))).toThrow(/same thing/);
        expect(() => A.normalizePolicy({ type: 'threshold' })).toThrow(/owner-count or an area/);
    });

    it('hashes exactly as before this change for configs published earlier, and for live proposal 879', () => {
        const rights = v1([
            { parcelId: 'p-a', complete: true, areaM2: 378.5, owners: [owner('owner-a')] },
            { parcelId: 'p-c', complete: true, areaM2: 440, owners: [owner('owner-c', '1/2'), owner('owner-d', '2/4')] },
            { parcelId: 'p-x', complete: false, areaM2: null, owners: [] }
        ]);
        const item = approvalConfig => ({ proposalId: 'x', cadastreParcelIds: ['p-c', 'p-a'], approvalConfig, lens: ['m2', 'm1'] });
        // Recorded with the previous engine (scratch run on 2026-10-16) before any rules code existed.
        expect(A.contextHash(item(null))).toBe('approval1-sha256:f45c7e58196fdbb0556357edb5e61726e93954ec9be7e2d9608dd492a52eaff3');
        expect(A.contextHash(item(config(rights, { type: 'unanimous' })))).toBe('approval1-sha256:b9e243a5a75acd6720e846dbd152969cb0efa724f44e34c9801538961ee39c7c');
        expect(A.contextHash(item(config(rights, threshold([1, 2], [7, 10, true]))))).toBe('approval1-sha256:6579c122b9d4a0350cc211ba44fb3d4bef56bf8b27e1f6406bc2a468af9345a4');
        // A pinned scheme is part of the context: the same rules under a scheme hash differently.
        const scheme = { type: 'rules', tests: [test('area', 'owners', 'all', 1, 2, true)], authorities: [{ authorityId: 'x' }] };
        expect(A.contextHash(item(config(rights, scheme, pin('es-ct-basic'))))).not.toBe(A.contextHash(item(config(rights, scheme))));
    });

    it('pins a scheme only when the rules are exactly its rules', () => {
        const madrid = pin('es-md-compensation');
        expect(A.normalizeConfig(config(null, R.policyOf(R.latest('es-md-compensation'), ['ayuntamiento']), madrid)).regime).toEqual(madrid);
        expect(() => A.normalizeConfig(config(null, rules([test('area', 'owners', 'all', 1, 2, true)], ['x']), madrid))).toThrow(/not es-md-compensation/);
        expect(() => A.normalizeConfig(config(null, rules([test('area', 'owners', 'all', 1, 2)], ['x', 'y']), madrid))).toThrow(/not es-md-compensation/);
        expect(() => A.normalizeConfig(config(null, { type: 'unanimous' }, { id: 'xx-none', version: '2026-10-11' }))).toThrow(/Unknown agreement rules/);
        expect(() => R.policyOf(R.latest('jp-association'), [])).toThrow(/needs 1 authority/);
    });
});

describe('counting under each kind of rule', () => {
    it('is exact at the boundary: Catalonia’s "more than half" fails where Madrid’s "at least half" passes', () => {
        const half = v1([{ parcelId: 'a', complete: true, areaM2: 100, owners: [owner('o-a')] }, { parcelId: 'b', complete: true, areaM2: 100, owners: [owner('o-b')] }]);
        const catalonia = proposal(half, R.policyOf(R.latest('es-ct-basic'), ['ajuntament']), pin('es-ct-basic'));
        const madrid = proposal(half, R.policyOf(R.latest('es-md-compensation'), ['ayuntamiento']), pin('es-md-compensation'));
        expect(A.tally(catalonia, ['o-a', 'ajuntament'])).toMatchObject({ supportMet: false, authorityMet: true, passed: false });
        expect(A.tally(madrid, ['o-a', 'ayuntamiento'])).toMatchObject({ supportMet: true, authorityMet: true, passed: true });
        expect(A.tally(madrid, ['o-a'])).toMatchObject({ supportMet: true, authorityMet: false, passed: false, authorities: [{ authorityId: 'ayuntamiento', approved: false }] });
        expect(A.tally(catalonia, ['o-a']).tests[0]).toMatchObject({ support: 100, total: 200, needed: 100, strict: true, met: false });
    });

    it('counts private holders only under Taiwan, and leaseholders and combined area under Japan', () => {
        const taiwan = proposal(mixed, R.policyOf(R.latest('tw-owner-organized'), ['county']), pin('tw-owner-organized'));
        // Private owners: A, B, C, D (the city is heard, not counted); private land 600 of the 1000 m².
        expect(testsOf(A.tally(taiwan, ['o-a', 'o-b', 'city', 'county']))).toEqual([
            ['area/owners/private', 500, 600, true], ['headcount/owners/private', 2, 4, true]
        ]);
        expect(A.tally(taiwan, ['o-a', 'o-b', 'city'])).toMatchObject({ supportMet: true, authorityMet: false, passed: false });
        expect(A.tally(taiwan, ['o-a', 'o-c', 'county'])).toMatchObject({ supportMet: false, passed: false });

        const japan = proposal(mixed, R.policyOf(R.latest('jp-association'), ['governor']), pin('jp-association'));
        // Combined private area: owned 600 + leased 100 = 700; A, B and the tenant hold 300+200+100.
        expect(testsOf(A.tally(japan, ['o-a', 'o-b', 't-1']))).toEqual([
            ['area/owners+leaseholders/private', 600, 700, true], ['headcount/leaseholders/private', 1, 1, true], ['headcount/owners/private', 2, 4, false]
        ]);
        expect(A.tally(japan, ['o-a', 'o-b', 'o-c', 't-1', 'governor']).passed).toBe(true);
        // Without the tenant the leaseholder test fails even though every owner agreed.
        expect(A.tally(japan, ['o-a', 'o-b', 'o-c', 'o-d', 'governor'])).toMatchObject({ supportMet: false, passed: false });
    });

    it('treats a test with nobody to count as met, and an authority-led scheme as the authority’s decision alone', () => {
        const noLeases = v1(parcels.slice(1, 3));
        const japanNoTenants = proposal(noLeases, R.policyOf(R.latest('jp-association'), ['governor']), pin('jp-association'));
        const tally = A.tally(japanNoTenants, ['o-b', 'o-c', 'o-d', 'governor']);
        expect(tally.tests.find(row => row.of === 'leaseholders')).toMatchObject({ vacuous: true, met: true, total: 0 });
        expect(tally.passed).toBe(true);

        const germany = proposal(noLeases, R.policyOf(R.latest('de-umlegung-new'), ['umlegungsstelle']), pin('de-umlegung-new'));
        expect(A.tally(germany, ['o-b', 'o-c', 'o-d'])).toMatchObject({ tests: [], supportMet: true, authorityMet: false, passed: false, acceptedOwners: 3 });
        expect(A.tally(germany, ['umlegungsstelle'])).toMatchObject({ passed: true, acceptedOwners: 0 });
        // Owners and their land are still reported for the card, though no test counts them.
        expect(A.tally(germany, ['o-b'])).toMatchObject({ totalOwners: 3, acceptedOwners: 1, totalAreaM2: 300, acceptedAreaM2: 200 });
    });

    it('needs whole heads and exact areas, and the review reports every party still to decide', () => {
        const item = proposal(mixed, rules([test('headcount', 'owners', 'all', 2, 3, true), test('area', 'owners', 'private', 1, 2)], ['council']));
        const progress = review.progress(item, ['o-a']);
        expect(progress.tests.map(row => [row.measure, row.needed])).toEqual([['area', 300], ['headcount', 4]]);
        expect(progress.outstanding.map(row => row.ownerId)).toEqual(['city', 'o-b', 'o-c', 'o-d']);
        expect(progress.authorities).toEqual([{ authorityId: 'council', approved: false }]);
        const asAuthority = review.ownerReview(item, 'council', { acceptedOwnerIds: ['o-a'] });
        expect(asAuthority).toMatchObject({ kind: 'authority', contributes: [], leases: [], alreadyAccepted: false });
        expect(asAuthority.progressWith.authorityMet).toBe(true);
        const asTenant = review.ownerReview(item, 't-1');
        expect(asTenant).toMatchObject({ kind: 'leaseholder', contributes: [], leases: [{ parcelId: 'a', leaseId: 'L1', share: '1/1', leaseAreaM2: 100, shareAreaM2: 100, coHolderIds: [] }] });
    });
});

describe('distribution rules of a scheme', () => {
    it('checks per-owner and pool caps and the distribution basis', () => {
        const owners = [{ ownerKey: 'o-a', contributedAreaM2: 100, assignedAreaM2: 65 }, { ownerKey: 'o-b', contributedAreaM2: 100, assignedAreaM2: 90 }];
        const germany = R.checkAllocation(R.latest('de-umlegung-new'), { basis: 'area', poolAreaM2: 200, owners });
        expect(germany).toEqual({ ok: false, rules: [{ kind: 'cap', per: 'owner', limit: { numerator: 3, denominator: 10 }, worst: { ownerKey: 'o-a', given: 0.35 }, ok: false }] });
        // The §58 cap applies to distribution by area only.
        expect(R.checkAllocation(R.latest('de-umlegung-new'), { basis: 'value', poolAreaM2: 200, owners }).rules).toEqual([]);
        expect(R.checkAllocation(R.latest('de-umlegung-developed'), { basis: 'area', poolAreaM2: 200, owners: [{ ownerKey: 'o-a', contributedAreaM2: 100, assignedAreaM2: 90 }] }).ok).toBe(true);
        const taiwan = R.checkAllocation(R.latest('tw-owner-organized'), { basis: 'value', poolAreaM2: 200, owners: [{ ownerKey: 'o-a', contributedAreaM2: 200, assignedAreaM2: 100 }] });
        expect(taiwan.rules).toEqual([{ kind: 'basis', required: 'value', actual: 'value', ok: true },
            { kind: 'cap', per: 'pool', limit: { numerator: 45, denominator: 100 }, given: 0.5, ok: false }]);
        expect(R.checkAllocation(R.latest('tr-article-18'), { basis: 'value', poolAreaM2: 100, owners: [] }).rules[0]).toMatchObject({ kind: 'basis', ok: false });
        expect(X.checkLines(germany, t, id => id.toUpperCase())).toEqual(['O-A gives up 35% of their land; the cap is 30%.']);
    });

    it('fails a plan that gives up more land than its scheme allows, and reports the check', () => {
        const rect = (west, south, east, north) => ({ type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] });
        const pool = rect(16, 46, 16.002, 46.001);
        // Each owner put in half the pool; A keeps a strip `ownerCut` wide of the 0.002° pool width.
        const half = turf.area({ type: 'Feature', properties: {}, geometry: pool }) / 2;
        const plan = (ownerCut) => ({
            goal: 'reparcellization', title: 'cap test', cadastreParcelIds: ['a', 'b'], offer: 0, offerCurrency: 'EUR', lens: ['m'],
            approvalConfig: config(v1([{ parcelId: 'a', complete: true, areaM2: 1000, owners: [owner('o-a')] }, { parcelId: 'b', complete: true, areaM2: 1000, owners: [owner('o-b')] }]),
                R.policyOf(R.latest('tr-article-18'), ['belediye']), pin('tr-article-18')),
            reparcellization: {
                poolGeometry: pool, contributionBasis: 'area',
                ownerShares: [{ ownerKey: 'o-a', contributedArea: half }, { ownerKey: 'o-b', contributedArea: half }, { ownerKey: 'public-land', contributedArea: 0 }],
                polygons: [{ geometry: rect(16, 46, 16 + ownerCut, 46.001), ownerKey: 'o-a' }, { geometry: rect(16 + ownerCut, 46, 16.001, 46.001), ownerKey: 'public-land' },
                    { geometry: rect(16.001, 46, 16.002, 46.001), ownerKey: 'o-b' }]
            }
        });
        // A keeps 0.0006 of 0.002: 30% of the pool, 60% of A's own land, so A gives up 40% (under 45%).
        const fine = validation.validate(plan(0.0006), { turf });
        expect(fine.regimeCheck.ok).toBe(true);
        expect(fine.errors.map(error => error.code)).not.toContain('regime-allocation');
        // A keeps 0.0004: 40% of A's land, so A gives up 60%.
        const over = validation.validate(plan(0.0004), { turf });
        expect(over.regimeCheck.rules.find(rule => rule.kind === 'cap')).toMatchObject({ ok: false, worst: { ownerKey: 'o-a' } });
        expect(over.errors.map(error => error.code)).toContain('regime-allocation');
        expect(over.valid).toBe(false);
    });
});

describe('words for the rules', () => {
    it('says each scheme’s rule in one sentence, and the meters by what they count', () => {
        const sentence = id => X.rulesText(A.normalizePolicy(R.policyOf(R.latest(id), R.latest(id).authorities ? ['x'] : [])), t, pin(id));
        expect(sentence('nl-kavelruil')).toBe('Configured approval rules require every owner to accept.');
        expect(sentence('es-ct-basic')).toBe('Configured approval rules require more than 1/2 of the area and the municipality’s approval of the compensation project.');
        expect(sentence('jp-association')).toBe('Configured approval rules require at least 2/3 of the private owners, at least 2/3 of the private leaseholders and at least 2/3 of the private owned and leased area and the prefectural governor’s approval.');
        expect(sentence('de-umlegung-new')).toBe('Configured approval rules require only the Umlegung authority’s adoption of the readjustment plan. Owner responses do not decide this tally.');
        expect(X.rulesText(threshold([1, 2], [7, 10]), t)).toBe('Configured approval rules require at least 1/2 of the owners and at least 7/10 of the area.');
        expect(X.meterName(test('headcount', 'owners', 'all', 1, 2))).toBe('owners');
        expect(X.meterName(test('area', 'owners+leaseholders', 'private', 1, 2))).toBe('area-owners-and-leaseholders-private');
        expect(X.meterLabel(test('headcount', 'leaseholders', 'all', 1, 2), t)).toBe('Leaseholders');
        expect(X.allocationLines(R.latest('tr-article-18'), t)).toEqual(['New plots are distributed by area.', 'No owner gives up more than 45% of their land.',
            'Land returns to its owners or goes to public use; a proposer cannot acquire it.']);
        expect(X.allocationLines(R.latest('de-umlegung-new'), t)[1]).toBe('Distributed by value, each owner is made whole to the value they put in; the whole value gain is settled in money.');
        expect(X.allocationLines(R.latest('in-gj-tps'), t)[1]).toBe('Distributed by value, 50% of each owner’s value gain is settled in money.');
        expect(X.allocationLines(R.latest('nl-kavelruil'), t)).toEqual(['At least 3 parties bring land in.']);
        expect(X.allocationLines(R.get('nl-kavelruil', '2026-10-11'), t)).toEqual([]);
    });

    it('states the party count and proposer rules, and the share of a value gain each scheme settles in money', () => {
        expect(R.valueGainRatio(R.latest('de-umlegung-developed'))).toBe(1);
        expect(R.valueGainRatio(R.latest('in-gj-tps'))).toBe(0.5);
        expect(R.valueGainRatio(R.latest('jp-association'))).toBe(0);
        expect(R.valueGainRatio(R.get('de-umlegung-new', '2026-10-11'))).toBe(0);
        expect(R.valueGainRatio(null)).toBe(0);
        const few = R.checkAllocation(R.latest('nl-kavelruil'), { basis: 'area', poolAreaM2: 100, owners: [], partyCount: 2 });
        expect(few).toEqual({ ok: false, rules: [{ kind: 'parties', required: 3, actual: 2, ok: false }] });
        expect(R.checkAllocation(R.latest('co-readjustment'), { basis: 'value', poolAreaM2: 100, owners: [], partyCount: 2 }).ok).toBe(true);
        // A fact that is left out skips its rule, so the older callers read as before.
        expect(R.checkAllocation(R.latest('nl-kavelruil'), { basis: 'area', poolAreaM2: 100, owners: [] }).rules).toEqual([]);
        const acquired = R.checkAllocation(R.latest('tr-article-18'), { basis: 'area', poolAreaM2: 100, owners: [], proposerAreaM2: 10 });
        expect(acquired.rules.find(rule => rule.kind === 'proposer')).toEqual({ kind: 'proposer', areaM2: 10, ok: false });
        expect(R.checkAllocation(R.latest('jp-association'), { basis: 'value', poolAreaM2: 100, owners: [], proposerAreaM2: 10 }).rules.some(rule => rule.kind === 'proposer')).toBe(false);
        expect(X.checkLines(few, t)).toEqual(['Only 2 bring land in; the scheme needs at least 3 parties.']);
        expect(X.checkLines(acquired, t)[2]).toBe('10 m² would go to a proposer; under this scheme land returns to its owners or goes to public use.');
    });
});

describe('the lens member and the relay with authorities', () => {
    const wallets = { a: wallet(), b: wallet(), tenant: wallet(), city: wallet(), authority: wallet() };
    const registryJson = {
        schema: 'lens-rights-registry/v1', publicBodies: ['city'],
        parcels: parcels.map(({ complete: _complete, ...parcel }) => parcel),
        authorities: [{ authorityId: 'planning-office', parcelIds: ['a', 'b', 'c', 'd'] }],
        signers: [{ ownerId: 'o-a', wallet: wallets.a.address }, { ownerId: 'o-b', wallet: wallets.b.address }, { ownerId: 't-1', wallet: wallets.tenant.address },
            { ownerId: 'city', wallet: wallets.city.address }, { ownerId: 'planning-office', wallet: wallets.authority.address }]
    };
    // The member's --rights file (lens-rights-registry/v1), read per request (lens/approval.js fileRegistry).
    const attester = () => createApprovalAttester({ keypair: memberKeypair, registry: fileRegistry(registryJson), clock: { nowSeconds: () => NOW } });
    // The agreement-like subject of the decisions: a published agreement's CID, its input parcels and rule.
    const item = (policy = R.policyOf(R.latest('jp-association'), ['planning-office']), regime = pin('jp-association')) => ({
        agreementCid: cidOf(Buffer.from('lens-regime agreement')), lifecycleStatus: 'Active',
        cadastreParcelIds: ['a', 'b', 'c', 'd'], approvalConfig: config(mixed, policy, regime), lens: [MEMBER]
    });
    const contextOf = p => ({ cadastreParcelIds: p.cadastreParcelIds, approvalConfig: p.approvalConfig, lens: p.lens });
    const factsFor = async (who, p, member = attester()) => {
        const challenged = member.issueChallenge({ wallet: who.address, contextHash: A.contextHash(p) });
        return member.attestAuthority({ wallet: who.address, challenge: challenged.challenge, signature: who.signText(challenged.message), ...contextOf(p) });
    };

    it('registers leases, public bodies and authorities, and names an authority wallet’s party', async () => {
        const registry = normalizeRegistry(registryJson);
        expect(registry.publicBodies.has('city')).toBe(true);
        expect(registry.authorities.get('planning-office')).toEqual(new Set(['a', 'b', 'c', 'd']));
        expect(() => normalizeRegistry({ ...registryJson, authorities: [{ authorityId: 'o-a', parcelIds: ['a'] }] })).toThrow(/not a rights holder/);
        expect(() => normalizeRegistry({ ...registryJson, authorities: [{ authorityId: 'z', parcelIds: ['nope'] }] })).toThrow(/registered parcels/);
        const facts = await factsFor(wallets.authority, item());
        expect(facts.authority.map(fact => fact.ownerId)).toEqual(['planning-office']);
        expect((await factsFor(wallets.tenant, item())).authority.map(fact => fact.ownerId)).toEqual(['t-1']);
        expect(await attester().status()).toMatchObject({ enabled: true, source: 'file', parcels: 4, owners: 6, authorities: 1, signers: 5 });
    });

    it('refuses a snapshot whose leases, public bodies or authority differ from its registry', async () => {
        const member = attester();
        const refuse = (p, code) => expect(member.attestRights(contextOf(p))).rejects.toMatchObject({ code });
        const withRights = rights => ({ ...item(), approvalConfig: config(rights, R.policyOf(R.latest('jp-association'), ['planning-office']), pin('jp-association')) });
        await refuse(withRights(v2(parcels.map(p => (p.parcelId === 'a' ? { ...p, leases: [] } : p)), { publicBodies: ['city'] })), 'leases_mismatch');
        await refuse(withRights(v2(parcels)), 'public_body_mismatch');
        await refuse(withRights(v2(parcels, { publicBodies: ['city', 'o-b'] })), 'public_body_mismatch');
        await refuse({ ...item(), approvalConfig: config(mixed, R.policyOf(R.latest('jp-association'), ['other-office']), pin('jp-association')) }, 'unknown_authority');
        const narrow = createApprovalAttester({ keypair: memberKeypair, clock: { nowSeconds: () => NOW },
            registry: fileRegistry({ ...registryJson, authorities: [{ authorityId: 'planning-office', parcelIds: ['a', 'b'] }] }) });
        await expect(narrow.attestRights(contextOf(item()))).rejects.toMatchObject({ code: 'authority_out_of_scope' });
        expect((await member.attestRights(contextOf(item()))).schema).toBe(proof.RIGHTS_SCHEMA);
    });

    it('admits and counts an authority’s signed decision like an owner’s', async () => {
        const p = item();
        const decision = async (who, ownerId, offset = 0) => {
            const facts = await factsFor(who, p);
            const receipt = { ownerId, actorId: who.address, evidence: { rights: facts.rights, authority: facts.authority.find(fact => fact.ownerId === ownerId) },
                decidedAt: at(offset), decision: 'approve', providerId: relay.LENS_PROVIDER };
            return { ...receipt, decisionProof: { scheme: proof.DECISION_SCHEME, signature: who.signText(proof.decisionMessage(A.decisionContent(p, receipt))) } };
        };
        const stored = [];
        for (const [who, id] of [[wallets.a, 'o-a'], [wallets.b, 'o-b'], [wallets.tenant, 't-1'], [wallets.authority, 'planning-office']]) {
            const verdict = relay.admit(p, stored, await decision(who, id, stored.length), { now: Date.now() });
            expect(verdict).toEqual({ ok: true });
            stored.push(await decision(who, id, stored.length));
        }
        // The city's wallet cannot sign for the authority, and vice versa.
        expect(relay.admit(p, stored, { ...(await decision(wallets.city, 'city')), ownerId: 'planning-office' }, { now: Date.now() })).toMatchObject({ ok: false });
        const verify = (q, receipt) => A.evidenceAllows(q, receipt.ownerId, receipt.actorId, receipt.evidence)
            && proof.verifySignature(receipt.actorId, proof.decisionMessage(A.decisionContent(q, receipt)), receipt.decisionProof.signature);
        const folded = relay.fold(p, stored, verify);
        const accepted = Object.keys(folded.ownerApprovals).sort();
        expect(accepted).toEqual(['o-a', 'o-b', 'planning-office', 't-1']);
        const tally = A.tally(p, accepted);
        expect(tally.authorityMet).toBe(true);
        // Owners A and B are 2 of 4 private owners: short of two thirds, so the authority alone does not pass it.
        expect(tally.passed).toBe(false);
        expect(A.tally(p, [...accepted, 'o-c']).passed).toBe(true);
    });
});
