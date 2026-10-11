import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockSolanaWallet, waitForBlockchainRuntime } from '../helpers/blockchain';

// The Bets sheet and the bet's own dialog: the map button with its "New" word, the contests
// GET /markets returns (filtered, with pool-less rows folded away), the way from a row into the
// dialog, and from the dialog into a bet (wallet first, then the stake form with its live "to win",
// then the receipt) or back to the rivals.
const PROPOSAL_ACCOUNT = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';
const SOLANA_WALLET = 'Cp886ML2Ja4FF3SMmyUeW16rRGsLrBcRW8kfWS1VfN7W';

function marketsPayload(market: Record<string, unknown> = { address: 'HQqbGtviQr5KRs4x8CWSCVhnkrLKDiYqXmVSBY8GZdfw', yesPool: '250000', noPool: '50000', poolAtomic: '300000', resolved: false, outcome: null }) {
  return {
    city: 'zagreb', generatedAt: '2026-10-09T07:00:00.000Z', cluster: 'devnet', stakeDecimals: 6,
    marketProgram: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB', stakeMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    summary: { contests: 1, proposals: 2, markets: 1, openMarkets: 1, poolAtomic: '300000' },
    contests: [{
      id: 'c-test', parcelIds: ['HR-335614-2311'], proposalCount: 2, mintedCount: 1, marketCount: 1, openMarketCount: 1,
      poolAtomic: '300000', latestCreatedAt: '2026-10-02T00:00:00Z',
      proposals: [
        { id: 789, proposalId: 'minted-one', title: 'Plan-led infill', goal: 'single', lifecycleStatus: 'Active', createdAt: '2026-10-01T09:30:00Z',
          expiresAt: null, author: 'densifier-01', agent: true, proposalRole: null, screenshotUrl: null, parcelIds: ['HR-335614-2311'],
          proposalAccount: PROPOSAL_ACCOUNT, bettable: !market.resolved, canOpenMarket: false, market },
        { id: 790, proposalId: 'rival', title: 'Rival park', goal: 'park', lifecycleStatus: 'Active', createdAt: '2026-10-02T00:00:00Z',
          expiresAt: null, author: 'someone', agent: false, proposalRole: null, screenshotUrl: null, parcelIds: ['HR-335614-2311'],
          proposalAccount: null, bettable: false, canOpenMarket: false, market: null }
      ]
    }]
  };
}

async function mockMarkets(page: import('@playwright/test').Page, payload = marketsPayload()): Promise<void> {
  await page.route('**/markets?*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) }));
}

async function captureClipboard(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { (window as any).__copied.push(text); } }
    });
  });
}

// The address follows the map as ?at=lat,lon,zoom (js/map-core.js), so the app address is compared
// without that view parameter.
const addressWithoutView = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const params = new URLSearchParams(location.search);
  params.delete('at');
  return `${location.pathname}?${params}`;
});

const expectedLink = (page: import('@playwright/test').Page) => page.evaluate((account) => `${location.origin}/bets/${account}?city=${(window as any).CityConfigManager.getCurrentCityId()}`, PROPOSAL_ACCOUNT);

test.describe('Bets sheet @features', () => {
  test('the Bets button wears "New" until the sheet is opened, which lists the contest with pool-less rows folded away', async ({ mockApi: page }) => {
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
    await expect(sheet.locator('#bets-sheet-filter .bets-filter__btn')).toHaveText(['All', 'Open', 'Settled', 'Mine']);
    await expect(sheet.locator('.bets-filter__btn[data-filter="all"]')).toHaveAttribute('aria-pressed', 'true');
    const contest = sheet.locator('.bets-contest');
    await expect(contest).toHaveCount(1);
    await expect(contest.locator('.bets-contest__title')).toHaveText('Which proposal gets built?');
    await expect(contest.locator('.bets-contest__land')).toContainText('Parcel 2311');
    // The minted row is in the open; the unminted rival is folded under a count.
    const rows = contest.locator('.bets-rows').first().locator('.bets-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0).locator('.bets-row__chance')).toHaveText('83.3% chance');
    await expect(rows.nth(0).locator('.bets-row__who')).toContainText('densifier-01');
    await expect(rows.nth(0).locator('.btn-market-yes')).toContainText('Pays 1.04×');
    await expect(rows.nth(0).locator('.btn-market-no')).toContainText('Pays 1.23×');
    const folded = contest.locator('details.bets-more');
    await expect(folded.locator('summary')).toHaveText('Without a pool: 1');
    await folded.locator('summary').click();
    await expect(folded.locator('.bets-row')).toContainText('Not minted yet');
    await expect(folded.locator('.bets-row__actions')).toHaveCount(0);
    // The filters: nothing is settled, and "Mine" without a wallet asks for one.
    await sheet.locator('.bets-filter__btn[data-filter="settled"]').click();
    await expect(sheet.locator('#bets-sheet-content')).toContainText('No bets match this filter.');
    await sheet.locator('.bets-filter__btn[data-filter="mine"]').click();
    await expect(sheet.locator('#bets-sheet-content')).toContainText('Connect a Solana wallet to see your bets.');
    await sheet.locator('.bets-filter__btn[data-filter="open"]').click();
    await expect(sheet.locator('.bets-row')).toHaveCount(1);
  });

  // bets.open (js/ui/commands.js) is a palette-only command: it is the keyboard way into the sheet.
  test('the command palette "Open bets" command opens the Bets sheet with its contests', async ({ mockApi: page }) => {
    await mockMarkets(page);
    await openCity(page);
    await expect(page.locator('#bets-sheet')).toBeHidden();
    const palette = page.locator('.command-palette-backdrop');
    await page.keyboard.press('Meta+k');
    await expect(palette).toBeVisible();
    await page.locator('.command-palette__input').fill('Open bets');
    const option = palette.locator('.command-palette__item[role="option"]').filter({ hasText: /^Open bets/ });
    await expect(option).toHaveCount(1);
    await option.click();
    await expect(palette).toBeHidden();
    const sheet = page.locator('#bets-sheet');
    await expect(sheet).toBeVisible();
    await expect(page.locator('#bets-button')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#bets-button-new')).toBeHidden();
    await expect(sheet.locator('.bets-contest')).toHaveCount(1);
    await expect(sheet.locator('.bets-contest__title')).toHaveText('Which proposal gets built?');
    await expect(sheet.locator('.bets-row').first().locator('.bets-row__chance')).toHaveText('83.3% chance');
  });

  test('a bet asks for a wallet first, then opens the stake form over the sheet with a live "to win"', async ({ mockApi: page }) => {
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
    await expect(dialog.locator('.cb-dialog__title')).toHaveText('Bet yes');
    await expect(page.locator('#bets-sheet')).toBeVisible();
    // The dialog is above the sheet, not behind it.
    const onTop = await page.evaluate(() => {
      const modal = document.querySelector('#proposalMarketOverlay .bets-dialog') as HTMLElement;
      const r = modal.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + 10);
      return !!(el && modal.contains(el));
    });
    expect(onTop).toBe(true);
    // 1 USDC on yes into 0.25 yes / 0.05 no: (0.25 + 0.05 + 1) / 1.25 = 1.04× → 1.04 USDC.
    await dialog.locator('[data-market-amount]').fill('1');
    await expect(dialog.locator('[data-market-towin]')).toContainText('To win about 1.04 USDC if yes wins');
    await dialog.locator('.bets-dialog__chip', { hasText: '5' }).first().click();
    await expect(dialog.locator('[data-market-amount]')).toHaveValue('5');
    await expect(dialog.locator('[data-market-towin]')).toContainText('To win about 5.05 USDC');
    // Back lands on the bet's overview, the Yes button goes to the form again.
    await dialog.getByRole('button', { name: 'Back' }).click();
    await expect(dialog.locator('.cb-dialog__title')).toHaveText('Plan-led infill');
    await dialog.locator('.bets-dialog__footer .btn-market-no').click();
    await expect(dialog.locator('.cb-dialog__title')).toHaveText('Bet no');
  });

  // The bet's receipt: the sheet stays open under the dialog, the dialog turns into "Bet placed" with
  // the pool read back from the chain, and the row behind it is refreshed, marked and carries the
  // wallet's own bet. Before this, the first press in the dialog closed the sheet (an "outside click")
  // and the dialog removed itself 300 ms after confirming, so a bet ended on the bare map.
  test('a confirmed bet shows its receipt over the sheet and the changed row behind it', async ({ mockApi: page }) => {
    await mockMarkets(page);
    await captureClipboard(page);
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await page.locator('#bets-button').click();
    await waitForBlockchainRuntime(page, ['SolanaMarketBridge', 'solanaWeb3']);
    await page.evaluate((proposalAccount) => {
      const bridge = (window as any).SolanaMarketBridge;
      const market = { stakeMint: 'mint', yesPool: 250000n, noPool: 100000n, resolved: false, outcome: 0 };
      bridge.stake = async (options: any) => {
        options.onStatus?.({ state: 'confirmed', signature: 'sig', explorerUrl: 'https://explorer.solana.com/tx/sig?cluster=devnet' });
        return { transactionHash: 'sig', explorerUrl: 'https://explorer.solana.com/tx/sig?cluster=devnet' };
      };
      bridge.readSummary = async () => ({ market, marketAddress: 'market', wallet: 'w', chainStatus: 'Active', yes: null, no: { side: 0, amount: 50000n, claimed: false } });
      bridge.readPositions = async () => ({ [proposalAccount]: { yes: null, no: { side: 0, amount: 50000n, claimed: false } } });
      bridge.readStakeBalance = async () => 12_500_000n;
    }, PROPOSAL_ACCOUNT);
    const row = page.locator('#bets-sheet .bets-row').first();
    await row.locator('.btn-market-no').click();
    const dialog = page.locator('#proposalMarketOverlay');
    // The wallet's balance fills "Max".
    await expect(dialog.locator('.bets-dialog__chip', { hasText: 'Max' })).toContainText('12.5');
    await dialog.locator('[data-market-amount]').fill('0.05');
    await dialog.locator('[data-market-submit]').click();
    await expect(dialog.locator('.cb-dialog__title')).toHaveText('Bet placed');
    await expect(dialog.locator('.proposal-boost-copy')).toHaveText('0.05 USDC on no is in the pool.');
    await expect(dialog.locator('.proposal-market-placed__pool')).toContainText('71.4% chance');
    await expect(dialog.locator('.proposal-market-placed__mine')).toHaveText('Your bets: no 0.05 USDC');
    await expect(page.locator('#bets-sheet')).toBeVisible();
    await expect(row).toHaveClass(/is-updated/);
    await expect(row.locator('.bets-row__mine')).toHaveText('Your bets: no 0.05 USDC');
    // The receipt carries the bet's link beside Done.
    await dialog.locator('[data-market-link]').click();
    await expect.poll(() => page.evaluate(() => (window as any).__copied)).toEqual([await expectedLink(page)]);
    await dialog.locator('[data-market-done]').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#bets-sheet')).toBeVisible();
  });

  test('a connected wallet skips the wallet step', async ({ mockApi: page }) => {
    await mockMarkets(page);
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await page.locator('#bets-button').click();
    await page.locator('#bets-sheet .bets-row').first().locator('.btn-market-no').click();
    await expect(page.locator('#proposalMarketOverlay')).toBeVisible();
    await expect(page.locator('#proposalMarketOverlay .cb-dialog__title')).toHaveText('Bet no');
  });

  // A shared bet link (js/bets/bets-link.js) opens the bet's own dialog: the title, the land, the
  // chance, the pool and payouts, who proposed it, the links; the first-visit explainer stays out
  // of the way. "Copy link" there puts the same link (the shareable path form, with the city) on
  // the clipboard, and the rivals button leads back to the contest in the list.
  test('a bet link opens the bet dialog, which copies that link and leads back to its contest', async ({ mockApi: page }) => {
    await mockMarkets(page);
    await captureClipboard(page);
    await page.goto(`/?city=zg&bets=${PROPOSAL_ACCOUNT}&reduceMotion=1`);
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#site-intro-modal')).toBeHidden();
    await expect(dialog.locator('.cb-dialog__title')).toHaveText('Plan-led infill');
    await expect(dialog.locator('.bets-dialog__eyebrow')).toContainText('Parcel 2311');
    await expect(dialog.locator('.bets-dialog__chance-word')).toHaveText('83.3% chance');
    const facts = dialog.locator('.bets-dialog__facts');
    await expect(facts).toContainText('0.30 USDC');
    await expect(facts).toContainText('Yes 1.04× · No 1.23×');
    await expect(facts).toContainText('No deadline set');
    await expect(facts).toContainText('densifier-01 · Agent proposal');
    await expect(dialog.locator('.bets-dialog__rule')).toContainText('Open for bets');
    await expect(dialog.locator('.bets-dialog__links a')).toHaveCount(2);
    await expect(dialog.locator('.bets-dialog__footer .btn-market-yes')).toContainText('Pays 1.04×');
    await dialog.locator('.bets-dialog__footer').getByRole('button', { name: 'Copy link' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__copied)).toEqual([await expectedLink(page)]);
    await dialog.locator('.bets-dialog__contest').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#bets-sheet')).toBeVisible();
    await expect(page.locator('#bets-sheet .bets-contest[data-contest-id="c-test"]')).toBeVisible();
    // The row's title opens the dialog again; while it is open the bet's own address stands in the
    // address bar (so a link copied from there unfurls like "Copy link"), and closing puts the app
    // address back.
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/');
    await page.locator('#bets-sheet .bets-row__title').first().click();
    await expect(page.locator('#proposalMarketOverlay .cb-dialog__title')).toHaveText('Plan-led infill');
    await expect.poll(() => addressWithoutView(page)).toBe(`/bets/${PROPOSAL_ACCOUNT}?city=zg&reduceMotion=1`);
    await page.locator('#proposalMarketOverlay .close-circle-btn').click();
    await expect.poll(() => addressWithoutView(page)).toBe('/?city=zg&reduceMotion=1');
  });

  test('the path form of a bet link opens the dialog too', async ({ mockApi: page }) => {
    await mockMarkets(page);
    await page.goto(`/bets/${PROPOSAL_ACCOUNT}?city=zg&reduceMotion=1`);
    await expect(page.locator('#proposalMarketOverlay .cb-dialog__title')).toHaveText('Plan-led infill');
  });

  // A pool with bets on one side only never reads "100% chance".
  test('a one-sided pool says so instead of printing a chance', async ({ mockApi: page }) => {
    await mockMarkets(page, marketsPayload({ address: 'HQqbGtviQr5KRs4x8CWSCVhnkrLKDiYqXmVSBY8GZdfw', yesPool: '250000', noPool: '0', poolAtomic: '250000', resolved: false, outcome: null }));
    await page.goto(`/?city=zg&bets=${PROPOSAL_ACCOUNT}&reduceMotion=1`);
    await expect(page.locator('#proposalMarketOverlay .bets-dialog__chance-word')).toHaveText('Only yes bets so far');
    await page.locator('#proposalMarketOverlay .close-circle-btn').click();
    await page.locator('#bets-button').click();
    await expect(page.locator('#bets-sheet .bets-row__chance').first()).toHaveText('Only yes bets so far');
  });

  // A settled pool the wallet can still collect from shows Collect on the row and in the dialog.
  test('a settled pool offers Collect on the row and in the dialog', async ({ mockApi: page }) => {
    await mockMarkets(page, marketsPayload({ address: 'HQqbGtviQr5KRs4x8CWSCVhnkrLKDiYqXmVSBY8GZdfw', yesPool: '250000', noPool: '50000', poolAtomic: '300000', resolved: true, outcome: 'yes' }));
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await waitForBlockchainRuntime(page, ['SolanaMarketBridge', 'solanaWeb3']);
    await page.evaluate((proposalAccount) => {
      const bridge = (window as any).SolanaMarketBridge;
      (window as any).__claims = [];
      bridge.readPositions = async () => ({ [proposalAccount]: { yes: { side: 1, amount: 100000n, claimed: false }, no: null } });
      bridge.claim = async (options: any) => {
        (window as any).__claims.push(options.side);
        options.onStatus?.({ state: 'confirmed', signature: 'sig', explorerUrl: 'https://explorer.solana.com/tx/sig?cluster=devnet' });
        return { transactionHash: 'sig', explorerUrl: 'https://explorer.solana.com/tx/sig?cluster=devnet' };
      };
    }, PROPOSAL_ACCOUNT);
    await page.locator('#bets-button').click();
    const row = page.locator('#bets-sheet .bets-row').first();
    await expect(row.locator('.bets-row__chance')).toHaveText('Settled yes');
    await expect(row.locator('.bets-row__mine')).toHaveText('Your bets: yes 0.10 USDC');
    await expect(row.locator('.bets-row__collect .btn')).toHaveText('Collect yes winnings');
    // "Mine" keeps the row; "Open" has nothing.
    await page.locator('#bets-sheet .bets-filter__btn[data-filter="mine"]').click();
    await expect(page.locator('#bets-sheet .bets-row')).toHaveCount(1);
    await page.locator('#bets-sheet .bets-filter__btn[data-filter="open"]').click();
    await expect(page.locator('#bets-sheet-content')).toContainText('No bets match this filter.');
    await page.locator('#bets-sheet .bets-filter__btn[data-filter="all"]').click();
    await page.locator('#bets-sheet .bets-row__title').first().click();
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog.locator('.bets-dialog__chance-word')).toHaveText('Settled yes');
    await expect(dialog.locator('.bets-dialog__mine')).toHaveText('Your bets: yes 0.10 USDC');
    await dialog.locator('.bets-dialog__collect .btn').click();
    await expect.poll(() => page.evaluate(() => (window as any).__claims)).toEqual([1]);
    await expect(dialog.locator('[data-market-dialog-status]')).toContainText('Collected yes winnings.');
  });
});
