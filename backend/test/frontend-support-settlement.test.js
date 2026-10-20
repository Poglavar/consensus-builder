import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);

const source = readFileSync(new URL('../../frontend/js/proposals/details-panel.js', import.meta.url), 'utf8');
const start = source.indexOf('async function settleProposalSupport(');
const end = source.indexOf('\nfunction openProposalLens(', start);
const chainRef = require('../../frontend/js/proposals/chain-ref.js');
const acceptanceClient = require('../../frontend/js/solana/acceptance-client.js');

for (const action of ['revokePledge', 'fulfillPledge', 'voidPledge', 'refundMyDonations', 'releaseDonations']) {
    it(`${action} reports its settlement rather than the donation amount template`, async () => {
        const alerts = [];
        const proposal = {
            proposalId: 'fixture-proposal',
            onchain: {
                chainId: 'solana-devnet',
                contractAddress: acceptanceClient.constants.PROPOSAL_NFT_PROGRAM_ID,
                proposalId: 'Token1111111111111111111111111111111111'
            }
        };
        const context = vm.createContext({
            window: {
                ChainProposalRef: chainRef,
                SolanaAcceptanceClient: acceptanceClient,
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


const coreSource = readFileSync(new URL('../../frontend/js/proposals/core.js', import.meta.url), 'utf8');
const alertStart = coreSource.indexOf('function showProposalAlertMessage(');
const alertEnd = coreSource.indexOf('\nfunction isParcelReplacedByChildren(', alertStart);

for (const translated of [true, false]) {
    it(`keeps the transaction-link slot when an alert uses ${translated ? 'a translation' : 'its fallback'}`, () => {
        const alerts = [];
        const parameters = { amount: '1.25', currency: 'USDC', txLink: 'https://example.test/transaction' };
        const options = { linkUrl: parameters.txLink, linkText: 'See transaction' };
        const context = vm.createContext({
            window: { showStyledAlert: (...args) => alerts.push(args) },
            getProposalI18nHelper: () => (_key, fallback, values) => {
                const template = translated ? 'Supported with {{amount}} {{currency}}. See {{txLink}}' : fallback;
                return template.replace(/\{\{(\w+)\}\}/g, (match, key) => values[key] ?? match);
            },
        });
        vm.runInContext(coreSource.slice(alertStart, alertEnd), context);
        context.showProposalAlertMessage('proposal_boost_success', 'Supported with {{amount}} {{currency}}.', parameters, options);
        expect(alerts).toHaveLength(1);
        expect(alerts[0][0]).toContain('Supported with 1.25 USDC.');
        expect(alerts[0][0].match(/\{\{txLink\}\}/g)).toHaveLength(1);
        expect(alerts[0][1]).toEqual(options);
        expect(parameters.txLink).toBe(options.linkUrl);
    });
}

it('keeps alerts without a transaction link as ordinary translated text', () => {
    const alerts = [];
    const context = vm.createContext({
        window: { showStyledAlert: (...args) => alerts.push(args) },
        getProposalI18nHelper: () => (_key, fallback) => fallback,
    });
    vm.runInContext(coreSource.slice(alertStart, alertEnd), context);
    context.showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
    expect(alerts).toEqual([['Proposal not found.', {}]]);
});
