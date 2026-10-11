// Validates abstract rights, independent authority providers, and exact owner/area approval rules.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
const providerSource = readFileSync(new URL('../../frontend/js/proposals/approval-providers.js', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('../../frontend/js/proposals/approval-runtime.js', import.meta.url), 'utf8');

const owner = (ownerId, share = '1/1', extra = {}) => ({ ownerId, share, ...extra });
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
const proposal = (parcels, {
    selected = parcels.map(row => row.parcelId),
    policy = { type: 'unanimous' }, lens = ['court-member-a'], sourceReference = 'snapshot-1'
} = {}) => ({
    proposalId: 'approval-test',
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
        const item = proposal([
            parcel('parcel-a', 100, [owner('owner-a')]),
            parcel('parcel-b', 50, [owner('owner-b')]),
            parcel('parcel-c', 25, [owner('owner-c', '1/2'), owner('owner-d', '1/2')])
        ]);

        expect(approval.inspect(item).ownerIds).toEqual(['owner-a', 'owner-b', 'owner-c', 'owner-d']);
        expect(approval.tally(item, ['owner-a', 'owner-b', 'owner-c'])).toMatchObject({
            ready: true, totalOwners: 4, acceptedOwners: 3,
            acceptedParcelIds: ['parcel-a', 'parcel-b'], totalAreaM2: 175,
            acceptedAreaM2: 150, passed: false
        });
    });

    it('counts one owner once when they own several declared parcels', () => {
        const item = proposal([
            parcel('parcel-a', 12, [owner('owner-a')]),
            parcel('parcel-b', 34, [owner('owner-a')])
        ]);

        expect(approval.tally(item, ['owner-a'])).toMatchObject({
            totalOwners: 1, acceptedOwners: 1,
            acceptedParcelIds: ['parcel-a', 'parcel-b'], totalAreaM2: 46, acceptedAreaM2: 46, passed: true
        });
    });

    it('credits whole-parcel area only after every co-owner agrees', () => {
        const item = proposal([
            parcel('shared-80', 80, [owner('owner-a', '1/2'), owner('owner-b', '1/2')]),
            parcel('solo-20', 20, [owner('owner-c')])
        ], { policy: threshold([1, 2], [7, 10]) });

        expect(approval.tally(item, ['owner-a'])).toMatchObject({ acceptedParcelIds: [], acceptedAreaM2: 0, areaThresholdMet: false, passed: false });
        expect(approval.tally(item, ['owner-a', 'owner-b'])).toMatchObject({
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
        const strict = proposal(parcels, { policy: threshold([1, 2], [7, 10], true) });
        const inclusive = proposal(parcels, { policy: threshold([1, 2], [7, 10], false) });

        expect(approval.tally(strict, ['owner-a', 'owner-d'])).toMatchObject({
            acceptedOwners: 2, acceptedAreaM2: 50, ownerThresholdMet: false, areaThresholdMet: false, passed: false
        });
        expect(approval.tally(inclusive, ['owner-a', 'owner-d'])).toMatchObject({
            ownerThresholdMet: true, areaThresholdMet: false, passed: false
        });
        expect(approval.tally(inclusive, ['owner-b', 'owner-c', 'owner-d'])).toMatchObject({
            ownerThresholdMet: true, areaThresholdMet: false, acceptedAreaM2: 60, passed: false
        });
        expect(approval.tally(inclusive, ['owner-a', 'owner-b', 'owner-d'])).toMatchObject({
            ownerThresholdMet: true, areaThresholdMet: true, acceptedAreaM2: 80, passed: true
        });
    });

    it('canonicalizes exact one-third interests and counts exact one-third owner and area thresholds', () => {
        const rawRights = rights([
            parcel('one-third', 1, [owner('owner-a', '1/3'), owner('owner-b', '2/6'), owner('owner-c', '1/3')]),
            parcel('two-thirds', 2, [owner('owner-c')])
        ]);
        // Use a separate three-owner electorate for the exact 1/3 headcount boundary.
        const thirds = proposal([
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
        expect(approval.tally(thirds, ['owner-a'])).toMatchObject({
            acceptedOwners: 1, acceptedAreaM2: 1, ownerThresholdMet: true, areaThresholdMet: true, passed: true
        });
        const strictThirds = { ...thirds, approvalConfig: {
            ...thirds.approvalConfig, policy: threshold([1, 3], [1, 3], true)
        } };
        expect(approval.tally(strictThirds, ['owner-a'])).toMatchObject({
            ownerThresholdMet: false, areaThresholdMet: false, passed: false
        });
    });

    it('fails closed for missing or incomplete rights instead of passing a zero-over-zero vote', () => {
        const missing = { cadastreParcelIds: [], approvalConfig: { schema: 'proposal-approval/v1', rights: null } };
        const incomplete = proposal([parcel('incomplete', null, [], false)]);

        expect(approval.tally(missing, [])).toMatchObject({ ready: false, reason: 'missing-rights', ownerThresholdMet: false, areaThresholdMet: false, passed: false });
        expect(approval.tally(incomplete, [])).toMatchObject({ ready: false, reason: 'incomplete-rights', ownerThresholdMet: false, areaThresholdMet: false, passed: false });
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
        const original = proposal([parcel('parcel-a', 10, [owner('stable-owner-id', '1/1', { name: 'Alice' })])]);
        const renamed = structuredClone(original);
        renamed.approvalConfig.rights.parcels[0].owners[0].name = 'Beatrice';

        expect(approval.inspect(original).ownerIds).toEqual(['stable-owner-id']);
        expect(approval.normalizeRights(original.approvalConfig.rights).parcels[0].owners[0]).toEqual({ ownerId: 'stable-owner-id', share: '1/1' });
        expect(approval.contextHash(renamed)).toBe(approval.contextHash(original));
        expect(() => approval.normalizeRights(rights([parcel('name-only', 10, [{ name: 'Alice', share: '1/1' }])]))).toThrow(/ownerId/);
    });

    it('binds source, lens, policy, rights, and selected cadastral scope while canonicalizing order', () => {
        const original = proposal([
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
        const item = proposal([parcel('parcel-a', 100, [owner('owner-a')])]);
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
            ownerId: 'owner-a', actorId: 'actor-a', effectHash: 'effect-1', acceptedAt: '2026-10-11T00:00:00.000Z',
            evidence: { ...validEvidence, authority: { ...validEvidence.authority, evidenceRef: 'caller-invented' } }
        };
        item.ownerApprovals = { 'owner-a': fakeReceipt };
        expect(approval.validOwnerIds(item, 'effect-1')).toEqual([]);
        const verifiedReceipt = { ...fakeReceipt, signature: 'verified-by-test-key', decision: 'approve', evidence: validEvidence };
        item.ownerApprovals = { 'owner-a': verifiedReceipt };
        expect(approval.validOwnerIds(item, 'effect-1', (_proposal, receipt) => receipt.signature === 'verified-by-test-key'))
            .toEqual(['owner-a']);
        expect(approval.evidenceAllows(item, 'owner-a', 'actor-b', validEvidence)).toBe(false);
        expect(validEvidence.authority.contextHash).toBe(contextHash);
    });

    it('records one owner across all their parcels, replaces changed terms, and archives approval and withdrawal receipts', () => {
        const item = proposal([
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
        const decide = (target, { effectHash, actorId = 'actor-a', decision = 'approve', acceptedAt }) => {
            const receipt = { ownerId: 'owner-a', actorId, effectHash, evidence: evidenceFor(item, 'owner-a', actorId), acceptedAt,
                decision, providerId: 'test-provider' };
            return approval.recordDecision(target, { ...receipt, withdraw: decision === 'withdraw',
                decisionProof: proofFor(target, receipt), verifyReceipt: verify });
        };

        const first = decide(item, { effectHash: 'effect-1', acceptedAt: '2026-10-11T00:00:00.000Z' });
        expect(first.tally).toMatchObject({ passed: true, acceptedParcelIds: ['parcel-a', 'parcel-b'], acceptedAreaM2: 100 });
        expect(approval.validOwnerIds(first.proposal, 'effect-1', verify)).toEqual(['owner-a']);

        const replacement = decide(first.proposal, { effectHash: 'effect-2', acceptedAt: '2026-10-11T00:01:00.000Z' });
        expect(replacement.tally).toMatchObject({ passed: true, acceptedParcelIds: ['parcel-a', 'parcel-b'] });
        expect(replacement.proposal.ownerApprovalHistory).toHaveLength(1);
        expect(replacement.proposal.ownerApprovalHistory[0]).toMatchObject({ effectHash: 'effect-1', decision: 'approve' });
        expect(approval.validOwnerIds(replacement.proposal, 'effect-1', verify)).toEqual([]);

        expect(() => decide(replacement.proposal, { effectHash: 'effect-2', actorId: 'actor-b', decision: 'withdraw',
            acceptedAt: '2026-10-11T00:02:00.000Z' })).toThrow(/Only the actor/);
        const withdrawn = decide(replacement.proposal, { effectHash: 'effect-2', decision: 'withdraw',
            acceptedAt: '2026-10-11T00:03:00.000Z' });
        expect(withdrawn.proposal.ownerApprovals).not.toHaveProperty('owner-a');
        expect(withdrawn.proposal.ownerApprovalHistory).toHaveLength(3);
        expect(withdrawn.proposal.ownerApprovalHistory[1]).toMatchObject({ effectHash: 'effect-2', decision: 'approve' });
        expect(withdrawn.proposal.ownerApprovalHistory[2]).toMatchObject({ effectHash: 'effect-2', decision: 'withdraw', actorId: 'actor-a' });
        expect(withdrawn.tally).toMatchObject({ passed: false, acceptedParcelIds: [], acceptedAreaM2: 0 });
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

    it('does not install authority from proposal data and verifies trusted async signatures against the current effect', async () => {
        const context = loadProviderRuntime();
        const item = proposal([parcel('parcel-a', 100, [owner('owner-a')])]);
        item.authorityResolver = { id: 'caller-invented', trusted: true };
        item.authorityEvidence = evidenceFor(item);
        item.ownerApprovals = {
            'owner-a': { ownerId: 'owner-a', actorId: 'actor-a', effectHash: 'effect-1', evidence: item.authorityEvidence }
        };
        const actor = { id: 'actor-a' };

        expect(context.ProposalApprovalAuthorities.resolve(item, 'owner-a', actor)).toBeNull();
        expect(await context.ProposalApprovalRuntime.decide(item, 'parcel-a', 'owner-a', actor, 'effect-1'))
            .toEqual({ error: 'authority-unresolved' });
        expect(context.ProposalApprovalRuntime.summary(item, 'effect-1').acceptedOwners).toBe(0);
        expect(context.ProposalApprovalRuntime.state(item, 'parcel-a', actor, 'effect-1').entries[0].termsChanged).toBe(false);
        // An unverified injected receipt must not block the genuine owner's later decision.

        const signedStatements = new Set();
        const unregister = context.ProposalApprovalAuthorities.register('test-trusted-authority', {
            authorize: request => {
                const proof = evidenceFor(item, request.ownerId, request.actor.id);
                proof.rights.contextHash = request.contextHash;
                proof.authority.contextHash = request.contextHash;
                return proof;
            },
            signDecision: async ({ statement }) => {
                const canonical = approval.stableStringify(statement);
                signedStatements.add(canonical);
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
        await expect(context.ProposalApprovalRuntime.decide(item, 'parcel-a', 'owner-a', actor, 'effect-1'))
            .resolves.toMatchObject({ passed: true, acceptedParcelIds: ['parcel-a'] });
        expect(context.ProposalApprovalRuntime.summary(item, 'effect-1')).toMatchObject({ acceptedOwners: 1, passed: true });
        expect(item.ownerApprovalHistory).toHaveLength(1);
        expect(item.ownerApprovalHistory[0].decisionProof).toBeUndefined();

        const stale = await context.ProposalApprovalRuntime.decide(item, 'parcel-a', 'owner-a', actor, 'effect-2', false, () => 'effect-3');
        expect(stale).toEqual({ error: 'terms-changed' });
        expect(item.ownerApprovals['owner-a'].effectHash).toBe('effect-1');
        unregister();
        expect(context.ProposalApprovalAuthorities.resolve(item, 'owner-a', actor)).toBeNull();
    });
});
