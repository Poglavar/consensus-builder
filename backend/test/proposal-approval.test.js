// Validates abstract rights, independent authority providers, and exact owner/area approval rules.
// Decisions are taken on an agreement and sign its CID (plan-design-agreement.md M2): the subject is
// an agreement-like object { agreementCid, cadastreParcelIds, approvalConfig, lens, ownerApprovals }.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
const Cid = require('../../frontend/js/cid.js');
// The agreement the decisions are taken on, and a counter-agreement over the same land and rule.
const AGREEMENT_CID = Cid.cidOfObject({ schema: 'agreement/v1', title: 'Approval test' });
const COUNTER_CID = Cid.cidOfObject({ schema: 'agreement/v1', title: 'Approval test, other terms' });
const providerSource = readFileSync(new URL('../../frontend/js/proposals/approval-providers.js', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('../../frontend/js/proposals/approval-runtime.js', import.meta.url), 'utf8');

const owner = (ownerId, share = '1/1', extra = {}) => ({ ownerId, share, ...extra });
// The tally reports one entry per test the rules count; the owner/area rule has exactly two.
const withMet = tally => ({
    ...tally,
    ownerThresholdMet: tally.tests.find(test => test.measure === 'headcount')?.met === true,
    areaThresholdMet: tally.tests.find(test => test.measure === 'area')?.met === true
});
const parcel = (parcelId, areaM2, owners, complete = true) => ({ parcelId, complete, areaM2, owners });
const rights = parcels => ({
    schema: 'parcel-rights/v1',
    source: { provider: 'upload', reference: 'snapshot-1' },
    parcels
});
const threshold = (owners, area, strict = false) => ({
    type: 'threshold',
    owners: { numerator: owners[0], denominator: owners[1], strict },
    area: { numerator: area[0], denominator: area[1], strict }
});
const agreement = (parcels, {
    selected = parcels.map(row => row.parcelId),
    policy = { type: 'unanimous' }, lens = ['court-member-a'], sourceReference = 'snapshot-1'
} = {}) => ({
    agreementCid: AGREEMENT_CID,
    cadastreParcelIds: selected,
    approvalConfig: {
        schema: 'proposal-approval/v1',
        rights: { ...rights(parcels), source: { provider: 'upload', reference: sourceReference } },
        policy
    },
    lens
});

function loadProviderRuntime() {
    const context = createContext({ ProposalApproval: approval, console, TextEncoder });
    runInContext(providerSource, context);
    runInContext(runtimeSource, context);
    return context;
}

function evidenceFor(target, ownerId = 'owner-a', actorId = 'actor-a', overrides = {}) {
    const contextHash = approval.contextHash(target);
    const member = target.lens[0];
    return {
        rights: { contextHash, member, evidenceRef: 'rights-proof-1', ...(overrides.rights || {}) },
        authority: {
            contextHash, member, evidenceRef: 'authority-proof-1', ownerId, actorId,
            ...(overrides.authority || {})
        }
    };
}

describe('parcel approval model', () => {
    it('counts four distinct owners across three parcels, including co-owned interests', () => {
        const item = agreement([
            parcel('parcel-a', 100, [owner('owner-a')]),
            parcel('parcel-b', 50, [owner('owner-b')]),
            parcel('parcel-c', 25, [owner('owner-c', '1/2'), owner('owner-d', '1/2')])
        ]);

        expect(approval.inspect(item).ownerIds).toEqual(['owner-a', 'owner-b', 'owner-c', 'owner-d']);
        expect(withMet(approval.tally(item, ['owner-a', 'owner-b', 'owner-c']))).toMatchObject({
            ready: true, totalOwners: 4, acceptedOwners: 3,
            acceptedParcelIds: ['parcel-a', 'parcel-b'], totalAreaM2: 175,
            acceptedAreaM2: 150, passed: false
        });
    });

    it('counts one owner once when they own several declared parcels', () => {
        const item = agreement([
            parcel('parcel-a', 12, [owner('owner-a')]),
            parcel('parcel-b', 34, [owner('owner-a')])
        ]);

        expect(withMet(approval.tally(item, ['owner-a']))).toMatchObject({
            totalOwners: 1, acceptedOwners: 1,
            acceptedParcelIds: ['parcel-a', 'parcel-b'], totalAreaM2: 46, acceptedAreaM2: 46, passed: true
        });
    });

    it('credits whole-parcel area only after every co-owner agrees', () => {
        const item = agreement([
            parcel('shared-80', 80, [owner('owner-a', '1/2'), owner('owner-b', '1/2')]),
            parcel('solo-20', 20, [owner('owner-c')])
        ], { policy: threshold([1, 2], [7, 10]) });

        expect(withMet(approval.tally(item, ['owner-a']))).toMatchObject({ acceptedParcelIds: [], acceptedAreaM2: 0, areaThresholdMet: false, passed: false });
        expect(withMet(approval.tally(item, ['owner-a', 'owner-b']))).toMatchObject({
            acceptedParcelIds: ['shared-80'], acceptedAreaM2: 80, areaThresholdMet: true, passed: true
        });
    });

    it('distinguishes strict 50% from at-least-50% and requires the 70% area threshold too', () => {
        const parcels = [
            parcel('a-40', 40, [owner('owner-a')]),
            parcel('b-30', 30, [owner('owner-b')]),
            parcel('c-20', 20, [owner('owner-c')]),
            parcel('d-10', 10, [owner('owner-d')])
        ];
        const strict = agreement(parcels, { policy: threshold([1, 2], [7, 10], true) });
        const inclusive = agreement(parcels, { policy: threshold([1, 2], [7, 10], false) });

        expect(withMet(approval.tally(strict, ['owner-a', 'owner-d']))).toMatchObject({
            acceptedOwners: 2, acceptedAreaM2: 50, ownerThresholdMet: false, areaThresholdMet: false, passed: false
        });
        expect(withMet(approval.tally(inclusive, ['owner-a', 'owner-d']))).toMatchObject({
            ownerThresholdMet: true, areaThresholdMet: false, passed: false
        });
        expect(withMet(approval.tally(inclusive, ['owner-b', 'owner-c', 'owner-d']))).toMatchObject({
            ownerThresholdMet: true, areaThresholdMet: false, acceptedAreaM2: 60, passed: false
        });
        expect(withMet(approval.tally(inclusive, ['owner-a', 'owner-b', 'owner-d']))).toMatchObject({
            ownerThresholdMet: true, areaThresholdMet: true, acceptedAreaM2: 80, passed: true
        });
    });

    it('canonicalizes exact one-third interests and counts exact one-third owner and area thresholds', () => {
        const rawRights = rights([
            parcel('one-third', 1, [owner('owner-a', '1/3'), owner('owner-b', '2/6'), owner('owner-c', '1/3')]),
            parcel('two-thirds', 2, [owner('owner-c')])
        ]);
        // Use a separate three-owner electorate for the exact 1/3 headcount boundary.
        const thirds = agreement([
            parcel('area-a', 1, [owner('owner-a')]),
            parcel('area-b', 1, [owner('owner-b')]),
            parcel('area-c', 1, [owner('owner-c')])
        ], { policy: threshold([1, 3], [1, 3]) });

        const normalized = approval.normalizeRights(rawRights);
        expect(normalized.parcels[0].owners).toEqual([
            { ownerId: 'owner-a', share: '1/3' },
            { ownerId: 'owner-b', share: '1/3' },
            { ownerId: 'owner-c', share: '1/3' }
        ]);
        expect(withMet(approval.tally(thirds, ['owner-a']))).toMatchObject({
            acceptedOwners: 1, acceptedAreaM2: 1, ownerThresholdMet: true, areaThresholdMet: true, passed: true
        });
        const strictThirds = { ...thirds, approvalConfig: {
            ...thirds.approvalConfig, policy: threshold([1, 3], [1, 3], true)
        } };
        expect(withMet(approval.tally(strictThirds, ['owner-a']))).toMatchObject({
            ownerThresholdMet: false, areaThresholdMet: false, passed: false
        });
    });

    it('fails closed for missing or incomplete rights instead of passing a zero-over-zero vote', () => {
        const missing = { cadastreParcelIds: [], approvalConfig: { schema: 'proposal-approval/v1', rights: null } };
        const incomplete = agreement([parcel('incomplete', null, [], false)]);

        expect(withMet(approval.tally(missing, []))).toMatchObject({ ready: false, reason: 'missing-rights', ownerThresholdMet: false, areaThresholdMet: false, passed: false });
        expect(withMet(approval.tally(incomplete, []))).toMatchObject({ ready: false, reason: 'incomplete-rights', ownerThresholdMet: false, areaThresholdMet: false, passed: false });
    });

    it('rejects bad shares, duplicate parcels or owners, and unsupported right kinds', () => {
        const invalid = [
            rights([parcel('bad-sum', 10, [owner('a', '3/4'), owner('b', '1/2')])]),
            rights([parcel('duplicate', 10, [owner('a')]), parcel('duplicate', 20, [owner('b')])]),
            rights([parcel('duplicate-owner', 10, [owner('a', '1/2'), owner('a', '1/2')])]),
            rights([parcel('unknown-kind', 10, [owner('a', '1/1', { kind: 'lease' })])])
        ];
        for (const value of invalid) {
            expect(() => approval.normalizeRights(value)).toThrowError(expect.objectContaining({ code: 'invalid-proposal-approval' }));
        }
        expect(() => approval.normalizeRights(rights([parcel('zero-share', 10, [owner('a', '0/1')])]))).toThrow(/positive/);
    });

    it('uses owner IDs rather than display names as identities and keeps renames cosmetic', () => {
        const original = agreement([parcel('parcel-a', 10, [owner('stable-owner-id', '1/1', { name: 'Alice' })])]);
        const renamed = structuredClone(original);
        renamed.approvalConfig.rights.parcels[0].owners[0].name = 'Beatrice';

        expect(approval.inspect(original).ownerIds).toEqual(['stable-owner-id']);
        expect(approval.normalizeRights(original.approvalConfig.rights).parcels[0].owners[0]).toEqual({ ownerId: 'stable-owner-id', share: '1/1' });
        expect(approval.contextHash(renamed)).toBe(approval.contextHash(original));
        expect(() => approval.normalizeRights(rights([parcel('name-only', 10, [{ name: 'Alice', share: '1/1' }])]))).toThrow(/ownerId/);
    });

    it('binds source, lens, policy, rights, and selected cadastral scope while canonicalizing order', () => {
        const original = agreement([
            parcel('parcel-a', 60, [owner('owner-a', '1/2'), owner('owner-b', '1/2')]),
            parcel('parcel-b', 40, [owner('owner-c')])
        ], { lens: ['member-a', 'member-b'] });
        const hash = approval.contextHash(original);
        const reordered = structuredClone(original);
        reordered.lens.reverse();
        reordered.approvalConfig.rights.parcels.reverse();
        reordered.approvalConfig.rights.parcels[1].owners.reverse();
        expect(approval.contextHash(reordered)).toBe(hash);

        const mutations = [
            value => { value.approvalConfig.rights.source.reference = 'snapshot-2'; },
            value => { value.lens = ['member-a', 'member-c']; },
            value => { value.approvalConfig.policy = threshold([1, 2], [7, 10]); },
            value => { value.approvalConfig.rights.parcels[0].owners[0].share = '1/3'; value.approvalConfig.rights.parcels[0].owners[1].share = '2/3'; },
            value => { value.cadastreParcelIds = ['parcel-a']; }
        ];
        for (const mutate of mutations) {
            const changed = structuredClone(original);
            mutate(changed);
            expect(approval.contextHash(changed)).not.toBe(hash);
        }
    });

    it('rejects forged or mismatched receipts and evidence for the wrong lens, owner, context, or actor', () => {
        const item = agreement([parcel('parcel-a', 100, [owner('owner-a')])]);
        const contextHash = approval.contextHash(item);
        const validEvidence = evidenceFor(item);
        expect(approval.evidenceAllows(item, 'owner-a', 'actor-a', validEvidence)).toBe(true);

        const variants = [
            evidenceFor(item, 'owner-a', 'actor-a', { rights: { member: 'other-lens' } }),
            evidenceFor(item, 'owner-a', 'actor-a', { authority: { ownerId: 'owner-b' } }),
            evidenceFor(item, 'owner-a', 'actor-a', { authority: { contextHash: 'stale-context' } }),
            evidenceFor(item, 'owner-a', 'actor-a', { authority: { actorId: 'actor-b' } })
        ];
        for (const evidence of variants) {
            expect(approval.evidenceAllows(item, 'owner-a', 'actor-a', evidence)).toBe(false);
        }

        const fakeReceipt = {
            ownerId: 'owner-a', actorId: 'actor-a', decision: 'approve', decidedAt: '2026-10-11T00:00:00.000Z',
            evidence: { ...validEvidence, authority: { ...validEvidence.authority, evidenceRef: 'caller-invented' } }
        };
        item.ownerApprovals = { 'owner-a': fakeReceipt };
        // Nothing counts without a verifier, or when the verifier refuses the receipt.
        expect(approval.validOwnerIds(item)).toEqual([]);
        expect(approval.validOwnerIds(item, () => false)).toEqual([]);
        const verify = (_agreement, receipt) => receipt.signature === 'verified-by-test-key';
        const verifiedReceipt = { ...fakeReceipt, signature: 'verified-by-test-key', evidence: validEvidence };
        item.ownerApprovals = { 'owner-a': verifiedReceipt };
        expect(approval.validOwnerIds(item, verify)).toEqual(['owner-a']);
        // A withdrawal is not an approval, and a draft agreement (no CID yet) counts nobody.
        expect(approval.validOwnerIds({ ...item, ownerApprovals: { 'owner-a': { ...verifiedReceipt, decision: 'withdraw' } } }, verify)).toEqual([]);
        expect(approval.validOwnerIds({ ...item, agreementCid: undefined }, verify)).toEqual([]);
        expect(approval.evidenceAllows(item, 'owner-a', 'actor-b', validEvidence)).toBe(false);
        expect(validEvidence.authority.contextHash).toBe(contextHash);
    });

    it('signs the agreement-decision/v1 statement naming the agreement’s CID, and no terms hash', () => {
        const item = agreement([parcel('parcel-a', 100, [owner('owner-a')])]);
        const receipt = { ownerId: 'owner-a', actorId: 'actor-a', decision: 'approve', decidedAt: '2026-10-11T00:00:00.000Z',
            evidence: evidenceFor(item), effectHash: 'ignored-terms', providerId: 'test-provider' };
        expect(approval.decisionContent(item, receipt)).toEqual({
            schema: approval.DECISION_SCHEMA, agreementCid: AGREEMENT_CID, ownerId: 'owner-a', actorId: 'actor-a',
            contextHash: approval.contextHash(item), decision: 'approve', decidedAt: '2026-10-11T00:00:00.000Z'
        });
        expect(approval.DECISION_SCHEMA).toBe('agreement-decision/v1');
        // Another agreement over the same land and rule is another statement; a draft has none.
        expect(approval.decisionContent({ ...item, agreementCid: COUNTER_CID }, receipt).agreementCid).toBe(COUNTER_CID);
        expect(() => approval.decisionContent({ ...item, agreementCid: undefined }, receipt)).toThrowError(expect.objectContaining({ code: 'invalid-proposal-approval' }));
        expect(() => approval.decisionContent({ ...item, agreementCid: 'agreement-1' }, receipt)).toThrow(/not a CID/);
    });

    it('records one owner across all their parcels once per agreement, and archives approval and withdrawal receipts', () => {
        const item = agreement([
            parcel('parcel-a', 40, [owner('owner-a')]),
            parcel('parcel-b', 60, [owner('owner-a')])
        ]);
        const signedStatements = new Set();
        const proofFor = (target, receipt) => {
            const statement = approval.stableStringify(approval.decisionContent(target, receipt));
            const proof = `trusted-signature:${statement}`;
            signedStatements.add(statement);
            return proof;
        };
        const verify = (target, receipt) => {
            const statement = approval.stableStringify(approval.decisionContent(target, receipt));
            return signedStatements.has(statement) && receipt.decisionProof === `trusted-signature:${statement}`;
        };
        const decide = (target, { actorId = 'actor-a', decision = 'approve', decidedAt }) => {
            const receipt = { ownerId: 'owner-a', actorId, evidence: evidenceFor(item, 'owner-a', actorId), decidedAt,
                decision, providerId: 'test-provider' };
            return approval.recordDecision(target, { ...receipt, withdraw: decision === 'withdraw',
                decisionProof: proofFor(target, receipt), verifyReceipt: verify });
        };

        const first = decide(item, { decidedAt: '2026-10-11T00:00:00.000Z' });
        expect(first.tally).toMatchObject({ passed: true, acceptedParcelIds: ['parcel-a', 'parcel-b'], acceptedAreaM2: 100 });
        expect(first.agreement.acceptedParcelIds).toEqual(['parcel-a', 'parcel-b']);
        expect(approval.validOwnerIds(first.agreement, verify)).toEqual(['owner-a']);
        // The input is not changed; the decision is on the copy returned.
        expect(item.ownerApprovals).toBeUndefined();
        // The approval signs this agreement's CID: it does not count for a counter-agreement.
        expect(approval.validOwnerIds({ ...first.agreement, agreementCid: COUNTER_CID }, verify)).toEqual([]);

        // One approval per owner and agreement: there are no terms to accept again.
        expect(() => decide(first.agreement, { decidedAt: '2026-10-11T00:01:00.000Z' })).toThrow(/already approved this agreement/);
        expect(() => decide(first.agreement, { actorId: 'actor-b', decision: 'withdraw',
            decidedAt: '2026-10-11T00:02:00.000Z' })).toThrow(/Only the actor/);
        const withdrawn = decide(first.agreement, { decision: 'withdraw', decidedAt: '2026-10-11T00:03:00.000Z' });
        expect(withdrawn.agreement.ownerApprovals).not.toHaveProperty('owner-a');
        expect(withdrawn.agreement.ownerApprovalHistory).toHaveLength(2);
        expect(withdrawn.agreement.ownerApprovalHistory[0]).toMatchObject({ decision: 'approve', decidedAt: '2026-10-11T00:00:00.000Z' });
        expect(withdrawn.agreement.ownerApprovalHistory[1]).toMatchObject({ decision: 'withdraw', actorId: 'actor-a', decidedAt: '2026-10-11T00:03:00.000Z' });
        expect(withdrawn.tally).toMatchObject({ passed: false, acceptedParcelIds: [], acceptedAreaM2: 0 });

        // Approving again after the withdrawal is a new decision; the history keeps both earlier ones.
        const again = decide(withdrawn.agreement, { decidedAt: '2026-10-11T00:04:00.000Z' });
        expect(again.tally).toMatchObject({ passed: true, acceptedParcelIds: ['parcel-a', 'parcel-b'] });
        expect(again.agreement.ownerApprovalHistory).toHaveLength(2);
        expect(again.agreement.ownerApprovals['owner-a']).toMatchObject({ decision: 'approve', decidedAt: '2026-10-11T00:04:00.000Z' });

        // A decision needs a proposed agreement, a signing time and a verified signature.
        const unsigned = { ownerId: 'owner-a', actorId: 'actor-a', evidence: evidenceFor(item), decidedAt: '2026-10-11T00:00:00.000Z', providerId: 'test-provider' };
        expect(() => approval.recordDecision({ ...item, agreementCid: undefined }, { ...unsigned, decisionProof: 'forged', verifyReceipt: () => true }))
            .toThrow(/published agreement/);
        expect(() => decide(item, { decidedAt: 'yesterday' })).toThrow(/not been verified/);
        expect(() => approval.recordDecision(item, { ...unsigned, decisionProof: 'forged', verifyReceipt: verify })).toThrow(/not been verified/);
    });
});

describe('approval providers and trusted runtime', () => {
    it('registers upload as a rights source without granting authority and reports unknown sources', async () => {
        const context = loadProviderRuntime();
        const snapshot = rights([parcel('parcel-a', 100, [owner('owner-a')])]);
        snapshot.authorityResolver = { id: 'caller-installed', trusted: true };
        snapshot.ownerApprovals = { 'owner-a': { actorId: 'caller' } };
        const loaded = await context.ProposalApprovalSources.load('upload', JSON.stringify(snapshot));

        expect(context.ProposalApprovalSources.list().map(provider => provider.id)).toEqual(['upload']);
        expect(loaded.source.provider).toBe('upload');
        expect(loaded).not.toHaveProperty('authorityResolver');
        await expect(context.ProposalApprovalSources.load('unknown-provider', '{}')).rejects.toThrow('Unknown rights provider.');
        await expect(context.ProposalApprovalSources.load('upload', JSON.stringify({ ...snapshot, source: { provider: 'other' } })))
            .rejects.toThrow('The rights snapshot names a different provider.');
    });

    it('does not install authority from agreement data, and decides on the agreement’s CID through a trusted provider', async () => {
        const context = loadProviderRuntime();
        const runtime = context.ProposalApprovalRuntime;
        const item = agreement([parcel('parcel-a', 100, [owner('owner-a')])]);
        item.authorityResolver = { id: 'caller-invented', trusted: true };
        item.authorityEvidence = evidenceFor(item);
        item.ownerApprovals = {
            'owner-a': { ownerId: 'owner-a', actorId: 'actor-a', decision: 'approve', decidedAt: '2026-10-11T00:00:00.000Z', evidence: item.authorityEvidence }
        };
        const actor = { id: 'actor-a' };

        expect(context.ProposalApprovalAuthorities.resolve(item, 'owner-a', actor)).toBeNull();
        expect(await runtime.decide(item, 'parcel-a', 'owner-a', actor)).toEqual({ error: 'authority-unresolved' });
        expect(runtime.summary(item).acceptedOwners).toBe(0);
        expect(runtime.state(item, 'parcel-a', actor).entries[0]).toMatchObject({ ownerId: 'owner-a', accepted: false, canAccept: false, canUndo: false });
        // The fifth argument is the withdraw flag: a terms hash in its place is refused.
        await expect(runtime.decide(item, 'parcel-a', 'owner-a', actor, 'effect-1')).rejects.toThrow(/withdraw is a boolean/);
        // An unverified injected receipt must not block the genuine owner's later decision.

        let cidWhileSigning = null;
        const signedStatements = new Set();
        const unregister = context.ProposalApprovalAuthorities.register('test-trusted-authority', {
            authorize: request => {
                const proof = evidenceFor(item, request.ownerId, request.actor.id);
                proof.rights.contextHash = request.contextHash;
                proof.authority.contextHash = request.contextHash;
                return proof;
            },
            signDecision: async ({ agreement: target, statement }) => {
                const canonical = approval.stableStringify(statement);
                signedStatements.add(canonical);
                // The agreement being decided on is given another CID while the wallet signs.
                if (cidWhileSigning) target.agreementCid = cidWhileSigning;
                return `trusted-signature:${canonical}`;
            },
            verifyReceipt: ({ receipt, statement }) => {
                const canonical = approval.stableStringify(statement);
                return signedStatements.has(canonical) && receipt.decisionProof === `trusted-signature:${canonical}`;
            }
        });
        const evidence = context.ProposalApprovalAuthorities.resolve(item, 'owner-a', actor);
        expect(evidence).toBeTruthy();
        expect(approval.evidenceAllows(item, 'owner-a', actor.id, evidence.evidence)).toBe(true);
        expect(runtime.authorizedOwnerIds(item, actor)).toEqual(['owner-a']);
        expect(runtime.state(item, 'parcel-a', actor).entries[0]).toMatchObject({ accepted: false, canAccept: true });

        // A draft agreement (no CID yet) cannot be decided, and nobody may act for it; a closed one takes no decision.
        const draft = { ...item, agreementCid: undefined };
        expect(await runtime.decide(draft, 'parcel-a', 'owner-a', actor)).toEqual({ error: 'not-proposed' });
        expect(runtime.authorizedOwnerIds(draft, actor)).toEqual([]);
        expect(await runtime.decide({ ...item, lifecycleStatus: 'Expired' }, 'parcel-a', 'owner-a', actor)).toEqual({ error: 'agreement-closed' });

        await expect(runtime.decide(item, 'parcel-a', 'owner-a', actor))
            .resolves.toMatchObject({ passed: true, acceptedParcelIds: ['parcel-a'], ownerId: 'owner-a' });
        expect(runtime.summary(item)).toMatchObject({ acceptedOwners: 1, passed: true });
        expect(item.ownerApprovals['owner-a']).toMatchObject({ actorId: 'actor-a', decision: 'approve', providerId: 'test-trusted-authority' });
        expect(item.ownerApprovalHistory).toHaveLength(1);
        expect(item.ownerApprovalHistory[0].decisionProof).toBeUndefined();
        expect(runtime.state(item, 'parcel-a', actor).entries[0]).toMatchObject({ accepted: true, canAccept: false, canUndo: true });
        // The acceptance is of this agreement only.
        expect(runtime.summary({ ...structuredClone(item), agreementCid: COUNTER_CID }).acceptedOwners).toBe(0);

        // The agreement changed while the wallet signed: nothing is recorded.
        const moving = structuredClone(item);
        cidWhileSigning = COUNTER_CID;
        expect(await runtime.decide(moving, 'parcel-a', 'owner-a', actor, true)).toEqual({ error: 'terms-changed' });
        expect(moving.ownerApprovals).toEqual(item.ownerApprovals);
        expect(moving.ownerApprovalHistory).toEqual(item.ownerApprovalHistory);
        cidWhileSigning = null;

        // The signer who accepted withdraws it, and the parcel stops counting.
        await expect(runtime.decide(item, 'parcel-a', 'owner-a', actor, true)).resolves.toMatchObject({ passed: false, acceptedParcelIds: [] });
        expect(item.ownerApprovals).not.toHaveProperty('owner-a');
        expect(item.ownerApprovalHistory.at(-1)).toMatchObject({ decision: 'withdraw', actorId: 'actor-a' });
        unregister();
        expect(context.ProposalApprovalAuthorities.resolve(item, 'owner-a', actor)).toBeNull();
    });
});
