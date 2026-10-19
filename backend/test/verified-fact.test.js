import { describe, expect, it } from 'vitest';
import { buildVerifiedProposalFact } from '../oracle/verified-fact.js';
import { createHash } from 'node:crypto';
import { PROPOSAL_PROGRAM_ID, STATUS_CANCELLED } from '../oracle/proposal-lifecycle.js';
import { proposalAccountBytes } from './fixtures/proposal-account.js';

const PROPOSAL = 'Gsvt6nMhsvfrEDgvcqZDzPKZhhqACFEi3mueMxQNQ6UT';
const LENS_MEMBER = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
const ACCOUNT = proposalAccountBytes({ status: STATUS_CANCELLED, lens: [LENS_MEMBER] });
const ACCOUNT_HASH = `sha256:${createHash('sha256').update(ACCOUNT).digest('hex')}`;

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
            hash: ACCOUNT_HASH,
            transaction: 'tx-cancel',
            transactionUrl: 'https://explorer.solana.com/tx/tx-cancel?cluster=devnet'
        },
        evidence: { proposalStatusByte: STATUS_CANCELLED, accountDataBase64: ACCOUNT.toString('base64') },
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
            recipe: { id: 'proposal-lifecycle-v2', subject: { proposalAccount: PROPOSAL } },
            verification: {
                status: 'verified',
                recipeHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
                lens: { status: 'resolved', decision: 'NO', outcome: 'cancelled' },
                checks: { subjectMatches: true, terminalStatusMatches: true }
            }
        });
        expect(bundle.verification.recipeHash).toBe(bundle.recipe.hash);
        // trustedAttesters derive from the lens in the hashed proposal account bytes.
        expect(bundle.recipe.trustedAttesters.map(attester => attester.address)).toEqual([PROPOSAL_PROGRAM_ID, LENS_MEMBER]);
        expect(bundle.verification).toMatchObject({ recipeId: 'proposal-lifecycle-v2', checks: { lensFromHashedAccount: true } });
    });

    it('keeps the precommitted v1 recipe for an event that carries no account bytes', () => {
        const { accountDataBase64, ...evidence } = event().evidence;
        expect(accountDataBase64).toBeDefined();
        const bundle = buildVerifiedProposalFact({ event: event({ evidence }), proposalAccount: PROPOSAL });
        expect(bundle.recipe).toMatchObject({ id: 'proposal-lifecycle-v1', trustedAttesters: [{ kind: 'solana_program', address: PROPOSAL_PROGRAM_ID }] });
        expect(bundle.verification).toMatchObject({ recipeId: 'proposal-lifecycle-v1', checks: { lensFromHashedAccount: false } });
    });

    it('refuses an event whose account bytes do not match its source hash (a swapped lens)', () => {
        const swapped = proposalAccountBytes({ status: STATUS_CANCELLED, lens: [PROPOSAL_PROGRAM_ID] });
        expect(() => buildVerifiedProposalFact({
            event: event({ evidence: { proposalStatusByte: STATUS_CANCELLED, accountDataBase64: swapped.toString('base64') } }),
            proposalAccount: PROPOSAL
        })).toThrow(/source hash/);
    });

    it('refuses mismatched subjects, statuses, attesters and incomplete provenance', () => {
        expect(() => buildVerifiedProposalFact({ event: event(), proposalAccount: PROPOSAL.replace(/^G/, 'H') }))
            .toThrow(/subject/);
        expect(() => buildVerifiedProposalFact({
            event: event({ evidence: { proposalStatusByte: 1, accountDataBase64: ACCOUNT.toString('base64') } }), proposalAccount: PROPOSAL
        })).toThrow(/status evidence/);
        expect(() => buildVerifiedProposalFact({
            event: event({ attester: { kind: 'solana_program', address: 'other' } }), proposalAccount: PROPOSAL
        })).toThrow(/trusted ProposalNFT/);
        expect(() => buildVerifiedProposalFact({
            event: event({ source: { hash: null, transaction: 'tx' } }), proposalAccount: PROPOSAL
        })).toThrow(/source hash/);
    });
});
