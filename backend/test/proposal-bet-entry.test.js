// Exercise the betting entry's prerequisite dialog and the fresh proposal pool lookup. (Design details
// lost their Bet on outcome button in M2, plan-design-agreement.md: markets attach to agreements.)
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const entrySource = readFileSync(new URL('../../frontend/js/proposals/bet-entry.js', import.meta.url), 'utf8');
const dialogSource = readFileSync(new URL('../../frontend/js/bets/bets-dialog.js', import.meta.url), 'utf8');
const model = require('../../frontend/js/bets/bets-model.js');

function setup() {
    const node = tag => ({ tag, children: [], appendChild(child) { this.children.push(child); return child; } });
    const root = { document: { createElement: node }, CbDialog: { open: vi.fn(options => options) }, BetsDialog: { open: vi.fn() } };
    vm.runInNewContext(entrySource, { window: root });
    return { root, entry: root.ProposalBetEntry };
}

describe('proposal panel betting entry', () => {
    it('explains minting for a local proposal and opens that proposal’s minting options only on click', () => {
        const { root, entry } = setup();
        const onMint = vi.fn();
        const help = entry.open({ proposal: { proposalId: 'local-1' }, onMint });
        expect(help.title).toBe('Bet on outcome');
        expect(help.body.children[0].textContent).toContain('minted on Solana');
        expect(help.body.children[1].children.map(step => step.textContent)).toEqual([
            'Connect your Solana wallet before minting this proposal.',
            'Open Share and choose Mint. Follow the wallet prompts and any parcel prerequisites.',
            'Return to this proposal and choose Bet on outcome. Open the pool if needed, then choose Yes or No and enter your stake.'
        ]);
        expect(root.BetsDialog.open).not.toHaveBeenCalled();
        expect(onMint).not.toHaveBeenCalled();
        help.actions.find(action => action.id === 'mint').onClick();
        expect(onMint).toHaveBeenCalledOnce();
    });

    it('opens the pool overview without choosing a side or sending a transaction', () => {
        const { root, entry } = setup();
        const proposal = { proposalId: 'proposal-1', title: 'Garden', lifecycleStatus: 'Cancelled' };
        entry.open({ proposal, nftInfo: { tokenId: 'account', chain: 'solana-devnet' } });
        expect(root.BetsDialog.open).toHaveBeenCalledWith({ proposalAccount: 'account', proposalId: 'proposal-1', title: 'Garden', lifecycleStatus: 'Cancelled' });
        expect(root.CbDialog.open).not.toHaveBeenCalled();
    });

    it.each([
        [{ tokenId: 'account', chain: 'ethereum' }, false, 'another chain'],
        [{ tokenId: 'account', chain: 'solana-devnet' }, true, 'ownership and approval'],
        [null, true, 'ownership and approval']
    ])('explains unsupported proposals without offering minting', (nftInfo, approvalSetup, text) => {
        const { root, entry } = setup();
        const help = entry.open({ proposal: { proposalId: 'p' }, nftInfo, approvalSetup });
        expect(help.body.children[0].textContent).toContain(text);
        expect(help.actions.map(action => action.id)).toEqual(['close']);
        expect(root.BetsDialog.open).not.toHaveBeenCalled();
    });
});

async function loadFresh(summary, options = {}, error = null) {
    const start = dialogSource.indexOf('async function loadRow(');
    const end = dialogSource.indexOf('\n    async function loadPositions(', start);
    const loader = vm.runInNewContext(`${dialogSource.slice(start, end)}; loadRow`, {
        sheet: () => null, bridge: () => ({ readSummary: async () => { if (error) throw error; return summary; } }),
        model: () => model, state: {}, console: { warn: vi.fn() }
    });
    return (await loader('account', { proposalId: 'p-1', title: 'Garden', ...options })).row;
}

describe('fresh proposal pool lookup', () => {
    it('offers opening a pool for a minted active proposal absent from the city list', async () => {
        expect(await loadFresh({ market: null, chainStatus: 'Active' })).toMatchObject({ state: 'needs-market', title: 'Garden', proposalId: 'p-1', proposalAccount: 'account' });
    });
    it('offers bets only while the proposal and pool are active', async () => {
        const market = { yesPool: 10n, noPool: 20n, resolved: false };
        expect(await loadFresh({ market, chainStatus: 'Active' })).toMatchObject({ state: 'open' });
        expect(await loadFresh({ market, chainStatus: 'Executed' })).toMatchObject({ state: 'settling' });
        expect(await loadFresh({ market: { ...market, resolved: true, outcome: 1 }, chainStatus: 'Executed' })).toMatchObject({ state: 'resolved-yes' });
        expect(await loadFresh({ market: null, chainStatus: 'Cancelled' })).toMatchObject({ state: 'closed' });
    });
    it('does not invite bets or pool creation when the chain cannot be read', async () => {
        expect(await loadFresh(null, {}, new Error('RPC unavailable'))).toMatchObject({ state: 'closed' });
    });
});
