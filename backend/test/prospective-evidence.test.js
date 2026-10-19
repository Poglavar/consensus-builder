import { describe, expect, it } from 'vitest';
import { collectProspectiveCandidates, selectProspectiveCourtEvidence } from '../oracle/prospective-evidence.js';

const CLOSE = 2_000;
const base = {
    parcelUid: 'HR-1-2/3', yesOperation: 'register ownership',
    noOperation: 'cancel ownership', closesAt: CLOSE
};
const candidate = (address, operation, sourceObservedAt, firstSeenAt) => ({
    address, firstSeenAt,
    evidence: { fields: { parcelUid: base.parcelUid, operation, sourceObservedAt } }
});

describe('prospective court evidence selection', () => {
    it('waits when no matching evidence was both observed and attested after close', () => {
        const result = selectProspectiveCourtEvidence({
            ...base,
            candidates: [
                candidate('source-too-old', base.yesOperation, CLOSE - 1, CLOSE + 1),
                candidate('attestation-too-old', base.yesOperation, CLOSE + 1, CLOSE - 1),
                { ...candidate('wrong-parcel', base.yesOperation, CLOSE + 1, CLOSE + 1), evidence: {
                    fields: { parcelUid: 'HR-other', operation: base.yesOperation, sourceObservedAt: CLOSE + 1 }
                } }
            ]
        });
        expect(result).toEqual({ status: 'waiting', selected: null, eligible: [] });
    });

    it('selects the earliest eligible matching record deterministically', () => {
        const later = candidate('z-address', base.yesOperation, CLOSE + 20, CLOSE + 30);
        const earlier = candidate('a-address', base.yesOperation, CLOSE + 10, CLOSE + 15);
        const result = selectProspectiveCourtEvidence({ ...base, candidates: [later, earlier] });
        expect(result.status).toBe('ready');
        expect(result.selected).toBe(earlier);
        expect(result.eligible).toHaveLength(2);
    });

    it('refuses contradictory eligible operations instead of choosing one', () => {
        const result = selectProspectiveCourtEvidence({
            ...base,
            candidates: [
                candidate('yes', base.yesOperation, CLOSE + 1, CLOSE + 2),
                candidate('no', base.noOperation, CLOSE + 3, CLOSE + 4)
            ]
        });
        expect(result.status).toBe('conflict');
        expect(result.selected).toBeNull();
    });
});

describe('prospective candidate collection from a program-account listing', () => {
    // Each listed account carries the fields its decode would yield; `bad` marks a non-court record.
    const listed = (address, fields, bad = false) => ({ address, account: { fields, bad } });
    const decode = (account, address) => {
        if (account.bad) throw new Error(`${address} is not a court attestation`);
        return { fields: account.fields };
    };

    it('looks up first-seen times only for this market, one at a time', async () => {
        const accounts = [
            listed('other-parcel', { parcelUid: 'HR-other', operation: base.yesOperation }),
            listed('other-operation', { parcelUid: base.parcelUid, operation: 'subdivide' }),
            listed('not-court', {}, true),
            listed('match-yes', { parcelUid: base.parcelUid, operation: base.yesOperation }),
            listed('match-no', { parcelUid: base.parcelUid, operation: base.noOperation })
        ];
        const calls = [];
        let inFlight = 0;
        let maxInFlight = 0;
        const firstSeen = async address => {
            calls.push(address);
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await Promise.resolve();
            inFlight -= 1;
            return { signature: `sig-${address}`, blockTime: CLOSE + 5 };
        };
        const candidates = await collectProspectiveCandidates({ ...base, accounts, decode, firstSeen });
        expect(calls).toEqual(['match-yes', 'match-no']);
        expect(maxInFlight).toBe(1);
        expect(candidates.map(c => [c.address, c.firstSeenAt, c.firstSeenSignature])).toEqual([
            ['match-yes', CLOSE + 5, 'sig-match-yes'],
            ['match-no', CLOSE + 5, 'sig-match-no']
        ]);
    });

    it('throws an RPC failure instead of dropping a candidate that could be the conflicting one', async () => {
        const accounts = [listed('match-no', { parcelUid: base.parcelUid, operation: base.noOperation })];
        const firstSeen = async () => { throw new Error('Too many requests for a specific RPC call'); };
        await expect(collectProspectiveCandidates({ ...base, accounts, decode, firstSeen }))
            .rejects.toThrow('Too many requests');
    });
});
