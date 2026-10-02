import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/proposals/details-panel.js', import.meta.url), 'utf8');
const start = source.indexOf('async function settleProposalSupport(');
const end = source.indexOf('\nfunction openProposalLens(', start);

for (const action of ['revokePledge', 'fulfillPledge', 'voidPledge', 'refundMyDonations', 'releaseDonations']) {
    it(`${action} reports its settlement rather than the donation amount template`, async () => {
        const alerts = [];
        const proposal = { proposalId: 'fixture-proposal' };
        const context = vm.createContext({
            window: {
                SolanaPledgeBridge: { [action]: async () => ({ explorerUrl: 'https://example.test/transaction' }) },
                solanaWalletManager: { getState: () => ({ accounts: ['fixture-wallet'] }) },
            },
            resolveProposalForBoost: () => proposal,
            getProposalNftInfo: () => ({ tokenId: 'fixture-account' }),
            proposalSupportInFlight: new Set(),
            showProposalAlertMessage: (...args) => alerts.push(args),
            recordHumanProposalSupport: async () => {},
            proposalSupportActor: () => ({ name: 'Fixture actor' }),
            showProposalInfo() {},
        });
        vm.runInContext(source.slice(start, end), context);
        await context.settleProposalSupport('fixture-proposal', action);
        expect(alerts).toHaveLength(1);
        expect(alerts[0][0]).toBe(`proposal_support_${action}_success`);
        expect(alerts[0][1]).not.toMatch(/boosting|\{\{/);
        expect(alerts[0][3].linkUrl).toBe('https://example.test/transaction');
        expect(context.proposalSupportInFlight.size).toBe(0);
    });
}
