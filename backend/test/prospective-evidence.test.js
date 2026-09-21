import { describe, expect, it } from 'vitest';
import { selectProspectiveCourtEvidence } from '../oracle/prospective-evidence.js';

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
