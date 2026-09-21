import { describe, expect, it } from 'vitest';
import { buildVerifiedProposalFact } from '../oracle/verified-fact.js';
import { PROPOSAL_PROGRAM_ID, STATUS_CANCELLED } from '../oracle/proposal-lifecycle.js';

const PROPOSAL = 'Gsvt6nMhsvfrEDgvcqZDzPKZhhqACFEi3mueMxQNQ6UT';

function event(overrides = {}) {
    return {
        id: `solana:devnet:proposal_lifecycle:${PROPOSAL}:cancelled`,
        eventType: 'proposal_lifecycle',
        subject: { type: 'proposal', id: PROPOSAL },
        outcome: 'cancelled',
        observedAt: '2026-09-21T16:24:07.000Z',
        recordedAt: '2026-09-21T16:27:35.059Z',
        attester: { kind: 'solana_program', address: PROPOSAL_PROGRAM_ID },
        source: {
            hash: `sha256:${'a'.repeat(64)}`,
            transaction: 'tx-cancel',
            transactionUrl: 'https://explorer.solana.com/tx/tx-cancel?cluster=devnet'
        },
        evidence: { proposalStatusByte: STATUS_CANCELLED },
        ...overrides
    };
}

describe('verified proposal fact bundle', () => {
    it('binds a source-hashed terminal event to its subject-specific recipe', () => {
        const bundle = buildVerifiedProposalFact({
            event: event({ observedAt: new Date('2026-09-21T16:24:07.000Z') }),
            proposalAccount: PROPOSAL
        });
        expect(bundle).toMatchObject({
            fact: { outcome: 'cancelled' },
            recipe: { id: 'proposal-lifecycle-v1', subject: { proposalAccount: PROPOSAL } },
            verification: {
                status: 'verified',
                recipeHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
                checks: { subjectMatches: true, terminalStatusMatches: true }
            }
        });
        expect(bundle.verification.recipeHash).toBe(bundle.recipe.hash);
    });

    it('refuses mismatched subjects, statuses, attesters and incomplete provenance', () => {
        expect(() => buildVerifiedProposalFact({ event: event(), proposalAccount: PROPOSAL.replace(/^G/, 'H') }))
            .toThrow(/subject/);
        expect(() => buildVerifiedProposalFact({
            event: event({ evidence: { proposalStatusByte: 1 } }), proposalAccount: PROPOSAL
        })).toThrow(/status evidence/);
        expect(() => buildVerifiedProposalFact({
            event: event({ attester: { kind: 'solana_program', address: 'other' } }), proposalAccount: PROPOSAL
        })).toThrow(/trusted ProposalNFT/);
        expect(() => buildVerifiedProposalFact({
            event: event({ source: { hash: null, transaction: 'tx' } }), proposalAccount: PROPOSAL
        })).toThrow(/source hash/);
    });
});
