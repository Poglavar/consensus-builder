import { describe, expect, it } from 'vitest';
import {
    assertProspectiveChronology,
    classifyExternalMarketChronology
} from '../oracle/external-market-chronology.js';

const base = {
    marketCreatedAt: 100,
    yesStakeAt: 110,
    noStakeAt: 120,
    marketClosesAt: 200,
    evidenceCreatedAt: 220,
    sourceObservedAt: 210,
    sourceTimeCommitted: true,
    resolvedAt: 230,
    claimedAt: 240
};

describe('external market chronology', () => {
    it('classifies evidence first published after close as prospective', () => {
        const proof = classifyExternalMarketChronology(base);
        expect(proof).toMatchObject({
            classification: 'prospective', prospective: true,
            marketOrderValid: true, attestationAfterClose: true, sourceAfterClose: true
        });
        expect(proof.timestamps.marketCreatedAt).toBe('1970-01-01T00:01:40.000Z');
    });

    it('does not overclaim when only the attestation creation time is fresh', () => {
        const proof = classifyExternalMarketChronology({ ...base, sourceObservedAt: null });
        expect(proof).toMatchObject({
            classification: 'onchain_prospective_source_time_unverified',
            prospective: false,
            sourceTimeVerified: false
        });
        expect(() => assertProspectiveChronology({ ...base, sourceObservedAt: null }))
            .toThrow(/source publication time is not committed/);
    });

    it('does not treat an operator-supplied source timestamp as committed evidence', () => {
        const proof = classifyExternalMarketChronology({ ...base, sourceTimeCommitted: false });
        expect(proof).toMatchObject({
            classification: 'onchain_prospective_source_time_unverified',
            prospective: false,
            sourceTimeVerified: false
        });
    });

    it('calls a market on pre-existing evidence a retrospective integration proof', () => {
        const proof = classifyExternalMarketChronology({
            ...base, evidenceCreatedAt: 50, sourceObservedAt: 40
        });
        expect(proof).toMatchObject({
            classification: 'retrospective_integration',
            prospective: false,
            attestationAfterClose: false
        });
    });

    it('rejects stakes submitted after close', () => {
        const proof = classifyExternalMarketChronology({ ...base, noStakeAt: 201 });
        expect(proof).toMatchObject({ classification: 'invalid', marketOrderValid: false });
    });
});
