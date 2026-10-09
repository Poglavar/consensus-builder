import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockSolanaWallet, waitForBlockchainRuntime } from '../helpers/blockchain';

// The Bets sheet: the map button with its "New" word, the contests GET /markets returns, and the
// way from a row into a bet (wallet first, then the stake dialog) or into the proposal's details.
const PROPOSAL_ACCOUNT = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';
const SOLANA_WALLET = 'Cp886ML2Ja4FF3SMmyUeW16rRGsLrBcRW8kfWS1VfN7W';

function marketsPayload() {
  return {
    city: 'zagreb', generatedAt: '2026-10-09T07:00:00.000Z', cluster: 'devnet', stakeDecimals: 6,
    marketProgram: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB', stakeMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    summary: { contests: 1, proposals: 2, markets: 1, openMarkets: 1, poolAtomic: '300000' },
    contests: [{
      id: 'c-test', parcelIds: ['HR-335614-2311'], proposalCount: 2, mintedCount: 1, marketCount: 1, openMarketCount: 1,
      poolAtomic: '300000', latestCreatedAt: '2026-10-02T00:00:00Z',
      proposals: [
        { id: 789, proposalId: 'minted-one', title: 'Plan-led infill', goal: 'single', lifecycleStatus: 'Active', createdAt: '2026-10-01T00:00:00Z',
          expiresAt: null, author: 'densifier-01', agent: true, proposalRole: null, screenshotUrl: null, parcelIds: ['HR-335614-2311'],
          proposalAccount: PROPOSAL_ACCOUNT, bettable: true, canOpenMarket: false,
          market: { address: 'HQqbGtviQr5KRs4x8CWSCVhnkrLKDiYqXmVSBY8GZdfw', yesPool: '250000', noPool: '50000', poolAtomic: '300000', resolved: false, outcome: null } },
        { id: 790, proposalId: 'rival', title: 'Rival park', goal: 'park', lifecycleStatus: 'Active', createdAt: '2026-10-02T00:00:00Z',
          expiresAt: null, author: 'someone', agent: false, proposalRole: null, screenshotUrl: null, parcelIds: ['HR-335614-2311'],
          proposalAccount: null, bettable: false, canOpenMarket: false, market: null }
      ]
    }]
  };
}

async function mockMarkets(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/markets?*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(marketsPayload()) }));
}

test.describe('Bets sheet @features', () => {
  test('the Bets button wears "New" until the sheet is opened, which lists the contest', async ({ mockApi: page }) => {
    await mockMarkets(page);
    await openCity(page);
    const button = page.locator('#bets-button');
    await expect(button).toBeVisible();
    await expect(page.locator('#bets-button-new')).toBeVisible();
    await button.click();
    const sheet = page.locator('#bets-sheet');
    await expect(sheet).toBeVisible();
    await expect(page.locator('#bets-button-new')).toBeHidden();
    await expect(sheet.locator('.bets-tagline strong')).toHaveText('Bet on cities');
    const contest = sheet.locator('.bets-contest');
    await expect(contest).toHaveCount(1);
    await expect(contest.locator('.bets-contest__title')).toHaveText('Which proposal gets built?');
    await expect(contest.locator('.bets-contest__land')).toContainText('Parcel 2311');
    const rows = contest.locator('.bets-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('.bets-row__chance')).toHaveText('83.3% chance');
    await expect(rows.nth(0).locator('.btn-market-yes')).toContainText('Pays 1.04×');
    await expect(rows.nth(0).locator('.btn-market-no')).toContainText('Pays 1.23×');
    await expect(rows.nth(1)).toContainText('Not minted yet');
    await expect(rows.nth(1).locator('.bets-row__actions')).toHaveCount(0);
  });

  test('a bet asks for a wallet first, then opens the stake dialog over the sheet', async ({ mockApi: page }) => {
    await mockMarkets(page);
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await page.locator('#bets-button').click();
    const yes = page.locator('#bets-sheet .bets-row').first().locator('.btn-market-yes');
    await yes.click();
    await expect(page.locator('.wallet-modal-overlay')).toBeVisible();
    await page.locator('[data-wallet-connector="solana-phantom"]').click();
    await expect(page.locator('.wallet-modal-overlay')).toHaveCount(0);
    await waitForBlockchainRuntime(page, ['SolanaMarketBridge', 'solanaWeb3']);
    await yes.click();
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#bets-sheet')).toBeVisible();
    // The dialog is above the sheet, not behind it.
    const onTop = await page.evaluate(() => {
      const modal = document.querySelector('#proposalMarketOverlay .proposal-boost-modal') as HTMLElement;
      const r = modal.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + 10);
      return !!(el && modal.contains(el));
    });
    expect(onTop).toBe(true);
  });

  test('a connected wallet skips the wallet step', async ({ mockApi: page }) => {
    await mockMarkets(page);
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await page.locator('#bets-button').click();
    await page.locator('#bets-sheet .bets-row').first().locator('.btn-market-no').click();
    await expect(page.locator('#proposalMarketOverlay')).toBeVisible();
    await expect(page.locator('#proposalMarketOverlay h3')).toHaveText('Bet no');
  });
});
