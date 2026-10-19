import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const provenance = require('../../frontend/js/proposals/agent-provenance.js');
const read = relative => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const verifiedProposal = {
    author: 'AgentWallet111111111111111111111111111111111',
    agent: {
        persona: 'densifier-01',
        rationale: 'The parcel is underused and beside frequent transit.',
        run_id: '2026-09-20-densifier-01',
        wallet: 'AgentWallet111111111111111111111111111111111',
        paid: {
            id: 'proposal_1234567890abcdef',
            network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
            asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
            amount: '0.05',
            amountAtomic: '50000',
            tx: 'SettlementSignature111111111111111111111111111'
        }
    }
};

describe('ProposalAgentProvenance', () => {
    it('turns a server-stamped payment into the shared display model', () => {
        expect(provenance.read(verifiedProposal)).toMatchObject({
            persona: 'densifier-01',
            rationale: verifiedProposal.agent.rationale,
            runId: verifiedProposal.agent.run_id,
            wallet: verifiedProposal.agent.wallet,
            paymentLabel: '0.05 USDC',
            transaction: verifiedProposal.agent.paid.tx,
            explorerUrl: `https://explorer.solana.com/tx/${verifiedProposal.agent.paid.tx}?cluster=devnet`
        });
    });

    it('does not badge an unverified client-supplied persona as a paid agent proposal', () => {
        expect(provenance.read({ agent: { persona: 'pretender' } })).toBeNull();
        expect(provenance.read({ agent: { wallet: 'wallet', paid: {} } })).toBeNull();
    });

    it('links mainnet and testnet settlements to the correct explorer cluster', () => {
        expect(provenance.solanaExplorerUrl('sig', 'solana:mainnet')).toBe('https://explorer.solana.com/tx/sig');
        expect(provenance.solanaExplorerUrl('sig', 'solana:testnet')).toBe('https://explorer.solana.com/tx/sig?cluster=testnet');
    });
});

describe('agent provenance UI contract', () => {
    const listUi = read('../../frontend/js/proposals/list-ui.js');
    const details = read('../../frontend/js/proposals/details-panel.js');

    it('uses the shared verified model in both proposal surfaces', () => {
        expect(listUi).toContain('ProposalAgentProvenance.read(proposal)');
        expect(listUi).toContain('proposal-agent-badge');
        expect(details).toContain('ProposalAgentProvenance.read(fullProposal)');
        expect(details).toContain('proposal-agent-provenance');
        expect(details).toContain('agentProvenance.explorerUrl');
    });

    it.each(['en', 'hr', 'sr', 'es'])('%s translates the provenance panel', locale => {
        const dictionary = JSON.parse(read(`../../frontend/i18n/${locale}.json`));
        expect(dictionary.panel.proposal.agent).toMatchObject({
            badge: expect.any(String),
            verified: expect.any(String),
            payer: expect.any(String),
            settlement: expect.any(String),
            flowDiscover: expect.any(String),
            flowPay: expect.any(String),
            flowStore: expect.any(String)
        });
    });
});
