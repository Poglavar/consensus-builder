// Verify lifecycle claims remain distinct from qualified observations and deadline derivation.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const evidenceModel = require('../../frontend/js/proposals/lifecycle-evidence.js');
const lifecycle = require('../../frontend/js/proposals/lifecycle.js');

const CHAIN_REF = {
    chainType: 'solana', chainId: 'solana-devnet',
    contract: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg', tokenId: 'proposal-account'
};

function chainMirror(status = 'Executed', observedAt = '2026-10-20T10:01:00.000Z') {
    return {
        protocol: 'proposal-chain/1',
        ref: CHAIN_REF,
        verifiedAt: '2026-10-20T10:02:00.000Z',
        lifecycle: { status, observedAt }
    };
}

function lifecycleEvent(outcome = 'executed') {
    const statusByte = { executed: 1, cancelled: 2, expired: 3 }[outcome];
    return {
        id: `solana:devnet:proposal_lifecycle:proposal-account:${outcome}`,
        eventType: 'proposal_lifecycle',
        subject: { type: 'proposal', id: 'proposal-account' },
        outcome,
        observedAt: '2026-10-20T10:00:00.000Z',
        attester: { kind: 'solana_program', address: CHAIN_REF.contract },
        source: { chain: 'solana:devnet', transaction: 'signature-1', hash: `sha256:${'a'.repeat(64)}` },
        evidence: { proposalStatusByte: statusByte }
    };
}

describe('proposal lifecycle evidence projection', () => {
    it('preserves the observed chain status, reference, and observation time', () => {
        const result = evidenceModel.projectLifecycleEvidence({ lifecycleStatus: 'Executed', chainMirror: chainMirror() });
        expect(result.lifecycleStatus).toBe('Executed');
        expect(result.lifecycleEvidence).toMatchObject({
            protocol: evidenceModel.PROTOCOL, state: 'observed', status: 'Executed',
            source: 'chain-mirror', observedAt: '2026-10-20T10:01:00.000Z',
            observations: [{ chainRef: CHAIN_REF, verifiedAt: '2026-10-20T10:02:00.000Z' }]
        });
    });

    it('preserves the later lifecycle event and earlier chain observation as separate evidence', () => {
        const result = evidenceModel.projectLifecycleEvidence({
            lifecycleStatus: 'Executed', chainMirror: chainMirror('Active', '2026-10-20T09:59:00.000Z'), lifecycleEvent: lifecycleEvent()
        });
        expect(result.lifecycleStatus).toBe('Executed');
        expect(result.lifecycleEvidence).toMatchObject({
            state: 'observed', source: 'land-event', observedAt: '2026-10-20T10:00:00.000Z',
        });
        expect(result.lifecycleEvidence.observations).toHaveLength(2);
        expect(result.lifecycleEvidence.observations[0]).toMatchObject({
            source: 'chain-mirror', status: 'Active', observedAt: '2026-10-20T09:59:00.000Z'
        });
        expect(result.lifecycleEvidence.observations[1]).toMatchObject({
            source: 'land-event', status: 'Executed', observedAt: '2026-10-20T10:00:00.000Z',
            transaction: 'signature-1', sourceHash: `sha256:${'a'.repeat(64)}`
        });
    });

    it('preserves historical terminal status while marking its evidence unknown', () => {
        const result = evidenceModel.projectLifecycleEvidence({
            lifecycleStatus: 'Executed', applied: true,
            localPurchaseSimulation: { executedAt: '2026-10-20T10:00:00.000Z' }
        });
        expect(result).toEqual({
            lifecycleStatus: 'Executed',
            lifecycleEvidence: {
                protocol: evidenceModel.PROTOCOL, state: 'unknown',
                claimedStatus: 'Executed', reason: 'no-matching-observation'
            }
        });
    });

    it('rejects a mismatched or malformed oracle event as lifecycle evidence', () => {
        const wrongSubject = lifecycleEvent();
        wrongSubject.subject.id = 'another-proposal';
        const result = evidenceModel.projectLifecycleEvidence({
            lifecycleStatus: 'Executed', chainMirror: chainMirror('Active'), lifecycleEvent: wrongSubject
        });
        expect(result.lifecycleStatus).toBe('Executed');
        expect(result.lifecycleEvidence.state).toBe('unknown');
    });

    it('does not let an older terminal event be overwritten by a contradictory later chain read', () => {
        const result = evidenceModel.projectLifecycleEvidence({
            lifecycleStatus: 'Active', chainMirror: chainMirror('Active'), lifecycleEvent: lifecycleEvent()
        });
        expect(result.lifecycleStatus).toBe('Active');
        expect(result.lifecycleEvidence).toMatchObject({ state: 'unknown', claimedStatus: 'Active' });
    });

    it('keeps deadline expiry as a qualified derived state without calling it a chain observation', () => {
        const result = evidenceModel.projectLifecycleEvidence({
            lifecycleStatus: 'Expired', expiresAt: '2026-10-19T00:00:00.000Z',
            now: new Date('2026-10-20T00:00:00.000Z')
        });
        expect(result).toEqual({
            lifecycleStatus: 'Expired',
            lifecycleEvidence: {
                protocol: evidenceModel.PROTOCOL, state: 'derived', source: 'expiry-deadline',
                status: 'Expired', expiresAt: '2026-10-19T00:00:00.000Z',
                evaluatedAt: '2026-10-20T00:00:00.000Z'
            }
        });
    });

    it('accepts a fresh, reference-bound browser chain read as a qualified observation', () => {
        const result = evidenceModel.projectLifecycleEvidence({
            lifecycleStatus: 'Cancelled',
            chainRead: { status: 'Cancelled', observedAt: '2026-10-20T10:04:00.000Z', chainRef: CHAIN_REF }
        });
        expect(result.lifecycleStatus).toBe('Cancelled');
        expect(result.lifecycleEvidence).toMatchObject({
            state: 'observed', status: 'Cancelled', source: 'chain-state-read',
            observedAt: '2026-10-20T10:04:00.000Z',
            observations: [{ source: 'chain-state-read', chainRef: CHAIN_REF }]
        });
    });

    it('qualifies unsupported execution without changing the lifecycle status', () => {
        expect(lifecycle.getProposalLifecycleKey({ lifecycleStatus: 'Executed' })).toBe('execution-unverified');
        const projected = evidenceModel.projectLifecycleEvidence({ lifecycleStatus: 'Executed', chainMirror: chainMirror() });
        expect(lifecycle.getProposalLifecycleKey(projected)).toBe('executed');
        expect(lifecycle.getProposalLifecycleKey({ lifecycleStatus: 'Cancelled' })).toBe('cancelled');
        expect(lifecycle.getProposalLifecycleKey({ lifecycleStatus: 'Expired' })).toBe('expired');
        expect(lifecycle.getProposalLifecycleKey({ lifecycleStatus: 'Expired', expiresAt: '2000-01-01T00:00:00Z' }))
            .toBe('expired');
        expect(lifecycle.getProposalLifecycleKey({ lifecycleStatus: 'Active', applied: true,
            localPurchaseSimulation: { completed: true } })).toBe('active');
    });
});
