import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const summary = require('../../frontend/js/proposals/consent-summary.js');
const approval = require('../../frontend/js/proposals/approval.js');

function localRecord() {
    return {
        cadastreParcelIds: ['parcel-a', 'parcel-b', 'parcel-a'], acceptedParcelIds: ['parcel-a', 'parcel-b'],
        ownerAcceptances: {
            'parcel-a': { ownerOrder: ['removed'], acceptedOwnerKeys: ['a', 'b', 'removed'],
                acceptedBy: { a: { effectHash: 'now' }, b: { effectHash: 'old' }, removed: { effectHash: 'now' } } },
            'parcel-b': { acceptedOwnerKeys: ['a'], acceptedBy: { a: { effectHash: 'now' } } }
        }
    };
}
const localOptions = { currentHash: 'now', ownerSlotsByParcel: {
    'parcel-a': [{ key: 'a' }, { key: 'b' }, { key: 'removed', placeholder: true }],
    'parcel-b': [{ key: 'a' }]
} };

describe('current local consent summaries', () => {
    it('uses current rosters and term hashes, not saved aggregates or stale owner orders', () => {
        const record = localRecord();
        const before = structuredClone(record);
        expect(summary.local(record, ['parcel-a'], localOptions)).toEqual({
            basis: 'local-records', parcelAccepted: false,
            owners: { accepted: 1, total: 2 }, parcels: { accepted: 1, total: 2 }
        });
        expect(record).toEqual(before);
    });

    it('counts equal local keys on separate source references as separate entries', () => {
        expect(summary.local(localRecord(), ['parcel-a', 'parcel-b'], localOptions))
            .toMatchObject({ owners: { accepted: 2, total: 3 }, parcelAccepted: false });
    });

    it('keeps missing rosters unknown and never lets history create an owner', () => {
        expect(summary.local(localRecord(), ['parcel-a'], { currentHash: 'now' }))
            .toMatchObject({ owners: null, parcels: null, parcelAccepted: null });
        expect(summary.local(localRecord(), ['parcel-a'], { ...localOptions, ownerSlotsByParcel: {
            'parcel-a': [{ key: 'removed', placeholder: true }], 'parcel-b': [{ key: 'a' }]
        } })).toMatchObject({ owners: null, parcels: null, parcelAccepted: null });
    });

    it('requires a current hash and all selected source rosters to be known', () => {
        expect(summary.local(localRecord(), ['parcel-a'], { ...localOptions, currentHash: null }))
            .toMatchObject({ owners: { accepted: 0, total: 2 }, parcels: { accepted: 0, total: 2 }, parcelAccepted: false });
        expect(summary.local(localRecord(), ['parcel-a', 'parcel-b'], {
            ...localOptions, ownerSlotsByParcel: { 'parcel-a': [{ key: 'a' }] }
        })).toMatchObject({ owners: null, parcels: null, parcelAccepted: null });
        expect(summary.local(localRecord(), ['outside'], localOptions))
            .toMatchObject({ owners: null, parcelAccepted: null, parcels: { accepted: 1, total: 2 } });
    });
});

function signedRecord() {
    const record = { proposalId: 'signed-record', cadastreParcelIds: ['parcel-a', 'parcel-b'], lens: ['member-a'],
        acceptedParcelIds: ['parcel-a', 'parcel-b'],
        approvalConfig: { schema: 'proposal-approval/v1', policy: { type: 'unanimous' },
            rights: { schema: 'parcel-rights/v1', source: { provider: 'fixture' }, parcels: ['parcel-a', 'parcel-b']
                .map(parcelId => ({ parcelId, areaM2: 100, complete: true, owners: [{ ownerId: 'owner-a', share: '1/1' }] })) } } };
    const contextHash = approval.contextHash(record);
    record.ownerApprovals = { 'owner-a': { ownerId: 'owner-a', actorId: 'signer-a', effectHash: 'now', decision: 'approve',
        decisionProof: 'test-verified-proof', evidence: {
            rights: { contextHash, member: 'member-a', evidenceRef: 'rights-proof' },
            authority: { contextHash, member: 'member-a', evidenceRef: 'authority-proof', ownerId: 'owner-a', actorId: 'signer-a' }
        } } };
    return record;
}
const verifyReceipt = (_record, receipt) => receipt.decisionProof === 'test-verified-proof';

describe('verified signed consent summaries', () => {
    it('counts a declared party once across selected references, without mutating saved aggregates', () => {
        const record = signedRecord();
        record.acceptedParcelIds = [];
        const before = structuredClone(record);
        expect(summary.signed(record, ['parcel-a', 'parcel-b'], { currentHash: 'now', verifyReceipt })).toEqual({
            basis: 'signed-receipts', parcelAccepted: true,
            owners: { accepted: 1, total: 1 }, parcels: { accepted: 2, total: 2 }
        });
        expect(record).toEqual(before);
    });

    it('rejects stale terms, invalid proof and mismatched rights/actor evidence', () => {
        const record = signedRecord();
        for (const options of [{ currentHash: 'old', verifyReceipt }, { currentHash: 'now', verifyReceipt: () => false }]) {
            expect(summary.signed(record, ['parcel-a'], options))
                .toMatchObject({ parcelAccepted: false, owners: { accepted: 0, total: 1 }, parcels: { accepted: 0, total: 2 } });
        }
        record.ownerApprovals['owner-a'].evidence.authority.actorId = 'another-signer';
        expect(summary.signed(record, ['parcel-a'], { currentHash: 'now', verifyReceipt }).parcelAccepted).toBe(false);
    });

    it('leaves incomplete rights and unavailable verification unknown', () => {
        const record = signedRecord();
        expect(summary.signed(record, ['parcel-a'], { currentHash: 'now' })).toEqual(summary.unknown(null));
        record.approvalConfig.rights = null;
        expect(summary.signed(record, ['parcel-a'], { currentHash: 'now', verifyReceipt }))
            .toEqual(summary.unknown('signed-receipts'));
    });
});
