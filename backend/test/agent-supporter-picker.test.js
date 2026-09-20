import { describe, expect, it } from 'vitest';
import { eligibleSupportProposals, selectSupportAction } from '../agents/supporter-picker.js';

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
            reason: 'No active minted proposal by another actor was available.'
        });
    });
});
