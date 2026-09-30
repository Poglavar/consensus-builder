import { describe, expect, it } from 'vitest';
import { classifySupportExecution, eligibleSupportProposals, selectSupportAction } from '../agents/supporter-picker.js';

const minted = (id, overrides = {}) => ({
    proposalId: id,
    name: `Proposal ${id}`,
    lifecycleStatus: 'Active',
    author: `wallet-${id}`,
    onchain: { proposalId: `pda-${id}` },
    agent: { persona: `agent-${id}` },
    ...overrides
});

describe('supporter agent policy', () => {
    it('only admits active minted proposals by another identity', () => {
        const proposals = [
            minted('good'),
            minted('draft', { lifecycleStatus: 'draft' }),
            minted('local', { onchain: null }),
            minted('self', { author: 'supporter-wallet' }),
            minted('same-persona', { agent: { persona: 'supporter-01' } })
        ];
        expect(eligibleSupportProposals(proposals, { wallet: 'supporter-wallet', personaName: 'supporter-01' })
            .map(item => item.proposalId)).toEqual(['good']);
    });

    it('makes the same auditable choice for the same day and policy', () => {
        const input = {
            day: '2026-09-21',
            persona: { name: 'supporter-01', support: { actions: ['pledge', 'donate'], amountUsdc: '0.10' } },
            proposals: [minted('a'), minted('b'), minted('c')],
            wallet: 'supporter-wallet'
        };
        const first = selectSupportAction(input);
        const second = selectSupportAction(input);
        expect(second).toEqual(first);
        expect(first.selected).toMatchObject({ amount: '0.10', proposalAccount: expect.stringMatching(/^pda-/) });
        expect(['pledge', 'donate']).toContain(first.selected.type);
        expect(first.selected.rationale).toMatch(/without using an LLM/);
    });

    it('returns an explicit no-op when no proposal is eligible', () => {
        const result = selectSupportAction({
            day: '2026-09-21', persona: { name: 'supporter-01' }, proposals: []
        });
        expect(result).toEqual({
            selected: null,
            eligibleProposalIds: [],
            excludedProposalIds: [],
            reason: 'No active minted proposal by another actor was available.'
        });
    });
});

describe('supporter agent never re-supports the same proposal', () => {
    const persona = { name: 'supporter-01', support: { actions: ['pledge'], amountUsdc: '0.10' } };
    const proposals = [minted('a'), minted('b'), minted('c')];

    it('excludes proposals this wallet already supports before ranking', () => {
        const all = selectSupportAction({ day: '2026-09-30', persona, proposals, wallet: 'supporter-wallet' });
        const excluded = selectSupportAction({
            day: '2026-09-30', persona, proposals, wallet: 'supporter-wallet',
            excludeProposalIds: [all.selected.proposalId]
        });
        expect(excluded.selected.proposalId).not.toBe(all.selected.proposalId);
        expect(excluded.eligibleProposalIds).toHaveLength(2);
        expect(excluded.excludedProposalIds).toEqual([all.selected.proposalId]);
        expect(excluded.selected.rationale).toMatch(/skipping 1 already supported/);
    });

    it('reports an explicit no-op once every other proposal is already supported', () => {
        const result = selectSupportAction({
            day: '2026-09-30', persona, proposals, wallet: 'supporter-wallet', excludeProposalIds: ['a', 'b', 'c']
        });
        expect(result.selected).toBeNull();
        expect(result.excludedProposalIds).toEqual(['a', 'b', 'c']);
        expect(result.reason).toBe('No active minted proposal by another actor remains unsupported (3 already supported).');
    });

    it('classifies a replayed adapter result as a no-op, never as a completed support', () => {
        expect(classifySupportExecution({ replayed: true, signature: null })).toEqual({ acted: false, runOutcome: 'already-supported' });
        expect(classifySupportExecution({ replayed: false, signature: null })).toEqual({ acted: false, runOutcome: 'already-supported' });
        expect(classifySupportExecution({ replayed: false, signature: 'sig' })).toEqual({ acted: true, runOutcome: 'completed' });
        expect(classifySupportExecution(undefined)).toEqual({ acted: false, runOutcome: 'already-supported' });
    });
});
