import { test, expect } from '../helpers/fixtures';
import type { Page } from '@playwright/test';
import { openCity } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockSolanaWallet, waitForBlockchainRuntime } from '../helpers/blockchain';
import { marketsPayload, pageIndex, MarketFixture } from '../helpers/mocks/shared-server';
import { fileIndexedAgreement, MINTED_ACCOUNT, OPEN_POOL, selectDevnetUsdc } from '../helpers/agreements';

// The Bets sheet and the bet's own dialog (plan-design-agreement.md, M3: bets are on minted
// agreements): the map button with its "New" word, the contests GET /markets returns (published
// agreements over the same land, filtered, with pool-less rows folded away), the way from a row into
// the dialog, and from the dialog into a bet (wallet first, then the stake form with its live "to
// win", then the receipt) or back to the rivals. The contests come from the page's index
// (mocks/shared-server.ts): the agreements filed there (helpers/agreements.ts fileIndexedAgreement,
// over parcel 2311), their chain records and their pools.
const ACCOUNT = MINTED_ACCOUNT;
const SOLANA_WALLET = 'Cp886ML2Ja4FF3SMmyUeW16rRGsLrBcRW8kfWS1VfN7W';
const TITLE = 'Plan-led infill';

// The city's contest: the minted agreement with an open pool, and an unminted rival over the same land.
function fileContest(page: Page, pool: MarketFixture = OPEN_POOL, status = 'active'): { cid: string; rival: string; contest: string } {
  const index = pageIndex(page);
  const { cid } = fileIndexedAgreement(index, { title: TITLE, minted: { status }, pool });
  const { cid: rival } = fileIndexedAgreement(index, { title: 'Rival park', author: 'someone', createdAt: '2026-10-02T00:00:00.000Z' });
  const [contest] = marketsPayload(index, 'zagreb').contests;
  expect(contest.agreements.map((entry: any) => entry.cid).sort()).toEqual([cid, rival].sort());
  return { cid, rival, contest: contest.id };
}

async function captureClipboard(page: Page): Promise<void> {
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
const addressWithoutView = (page: Page) => page.evaluate(() => {
  const params = new URLSearchParams(location.search);
  params.delete('at');
  for (const key of ['existing', 'permitted', 'proposed', 'existingScope', 'proposedForm', 'permittedForm', 'permittedMap', 'zoningAreas']) params.delete(key);
  return `${location.pathname}?${params}`;
});

const expectedLink = (page: Page) => page.evaluate((account) => `${location.origin}/bets/${account}?city=${(window as any).CityConfigManager.getCurrentCityId()}&asset=devnet-usdc&betTest=local-preview`, ACCOUNT);

const QUESTION = new RegExp(`Will ${TITLE} execute by`);

test.describe('Bets sheet @features', () => {
  test.beforeEach(async ({ mockApi: page }) => { await selectDevnetUsdc(page); });
  test('an unknown chain status shows no bet or settle action even after the agreement deadline', async ({ mockApi: page }) => {
    // The index never observed the account's status, and the deadline has passed: nothing settles.
    fileIndexedAgreement(pageIndex(page), { title: TITLE, minted: { status: null }, pool: OPEN_POOL, deadline: '2026-10-01T00:00:00.000Z' });
    await openCity(page);
    await page.locator('#bets-button').click();
    const sheet = page.locator('#bets-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Not open for bets', { timeout: 30_000 });
    const row = sheet.locator('.bets-row').filter({ hasText: TITLE });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-account', ACCOUNT);
    await expect(row.locator('.bets-row__actions')).toHaveCount(0);
    await expect(row).not.toContainText('Decided on-chain');
    await expect(row.locator('.bets-row__meta')).toContainText('Deadline');
    await expect(sheet.locator('.bets-how')).toContainText('YES if this agreement executes on-chain by');
    await row.locator('.bets-row__title').click();
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.bets-dialog__facts')).toContainText('Bet deadline');
    await expect(dialog.locator('.cb-dialog__footer .btn-market-yes, .cb-dialog__footer .btn-market-no')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Settle bet', exact: true })).toHaveCount(0);
  });

  test('a bet dialog cannot use a passed deadline as evidence for chain settlement', async ({ mockApi: page }) => {
    // The city lists nothing; the dialog reads the pool and the account's status from the chain.
    await openCity(page);
    await waitForBlockchainRuntime(page, ['SolanaMarketBridge', 'solanaWeb3']);
    await page.evaluate(async (account) => {
      (window as any).SolanaMarketBridge.readSummary = async () => ({
        market: { model: 'lmsr', asset: 'devnet-usdc', b: '100000000', qYes: '1000000', qNo: '1000000',
          seed: '69314720', closesAt: 1798761600, graceSeconds: 0, maxPosition: '0', paidOut: '0',
          creator: 'sponsor', resolved: false, outcome: null },
        marketAddress: 'test-market', chainStatus: null, deadline: '2026-10-01T00:00:00Z'
      });
      await (window as any).openBetDialog({ account, title: 'Status unavailable' });
    }, ACCOUNT);
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.cb-dialog__title')).toContainText('Will Status unavailable execute by');
    await expect(dialog.locator('.bets-dialog__rule')).toContainText('YES if this agreement executes on-chain by');
    await expect(dialog.getByRole('button', { name: 'Settle bet', exact: true })).toHaveCount(0);
    await expect(dialog.locator('.btn-market-yes, .btn-market-no')).toHaveCount(0);
    await expect(dialog).not.toContainText('Ready to settle');
  });

  test('the Bets button wears "New" until opened, and folds market-less rival agreements away', async ({ mockApi: page }) => {
    const { cid, rival } = fileContest(page);
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
    await expect(contest).toHaveCount(1, { timeout: 30_000 });
    // Agreements over one parcel share a contest, but their outcomes are independent.
    await expect(contest.locator('.bets-contest__title')).toHaveText('Markets for agreements over Parcel 2311');
    // (The amount and its currency are joined by a no-break space.)
    await expect(contest.locator('.bets-contest__land')).toContainText('2 agreements');
    await expect(contest.locator('.bets-contest__land')).not.toContainText('Pool');
    // The minted row has an LMSR market; the unminted rival is folded under a count.
    const rows = contest.locator('.bets-rows').first().locator('.bets-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toHaveAttribute('data-cid', cid);
    await expect(rows.nth(0)).toHaveAttribute('data-account', ACCOUNT);
    await expect(rows.nth(0).locator('.bets-row__chance')).toContainText('YES price');
    await expect(rows.nth(0).locator('.bets-row__who')).toContainText('densifier-01');
    await expect(rows.nth(0).locator('.btn-market-yes')).toContainText('Pays 1.');
    await expect(rows.nth(0).locator('.btn-market-no')).toContainText('Pays 1.');
    const folded = contest.locator('details.bets-more');
    await expect(folded.locator('summary')).toHaveText('Without a pool: 1');
    await folded.locator('summary').click();
    await expect(folded.locator('.bets-row')).toHaveAttribute('data-cid', rival);
    await expect(folded.locator('.bets-row')).toContainText('Agreement not minted yet');
    await expect(folded.locator('.bets-row__actions')).toHaveCount(0);
    // The filters: nothing is settled, and "Mine" without a wallet asks for one.
    await sheet.locator('.bets-filter__btn[data-filter="settled"]').click();
    await expect(sheet.locator('#bets-sheet-content')).toContainText('No bets match this filter.');
    await sheet.locator('.bets-filter__btn[data-filter="mine"]').click();
    await expect(sheet.locator('#bets-sheet-content')).toContainText('Connect a Solana wallet to see your bets.');
    await sheet.locator('.bets-filter__btn[data-filter="open"]').click();
    await expect(sheet.locator('.bets-row')).toHaveCount(1);
    // The sheet read the city's markets from the index.
    expect(pageIndex(page).requests.some(request => request.method === 'GET' && /^\/markets\?city=zg\b/.test(request.path))).toBe(true);
  });

  test('a city with no minted agreement explains that a dated agreement is needed', async ({ mockApi: page }) => {
    // Proposed but never minted: a contest nobody can bet on is not a market.
    fileIndexedAgreement(pageIndex(page), { title: 'Unminted plan' });
    await openCity(page);
    await page.locator('#bets-button').click();
    await expect(page.locator('#bets-sheet-content')).toContainText('No markets in this city yet. Mint an agreement with a deadline to open the first one.', { timeout: 30_000 });
    await expect(page.locator('#bets-sheet .bets-contest')).toHaveCount(0);
  });

  // bets.open (js/ui/commands.js) is a palette-only command: it is the keyboard way into the sheet.
  test('the command palette "Open bets" command opens the Bets sheet with its contests', async ({ mockApi: page }) => {
    fileContest(page);
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
    await expect(sheet.locator('.bets-contest')).toHaveCount(1, { timeout: 30_000 });
    await expect(sheet.locator('.bets-contest__title')).toHaveText('Markets for agreements over Parcel 2311');
    await expect(sheet.locator('.bets-row').first().locator('.bets-row__chance')).toContainText('YES price');
  });

  test('a devnet-USDC bet asks for a wallet first, then opens an LMSR buy form over the sheet', async ({ mockApi: page }) => {
    fileContest(page);
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
    await expect(dialog.locator('.bets-dialog__lead')).toHaveText(QUESTION);
    await expect(page.locator('#bets-sheet')).toBeVisible();
    // The dialog is above the sheet, not behind it.
    const onTop = await page.evaluate(() => {
      const modal = document.querySelector('#proposalMarketOverlay .bets-dialog') as HTMLElement;
      const r = modal.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + 10);
      return !!(el && modal.contains(el));
    });
    expect(onTop).toBe(true);
    // The LMSR quote prices all purchased shares at current inventory, with price impact.
    await dialog.locator('[data-market-amount]').fill('1');
    await expect(dialog.locator('[data-market-towin]')).toContainText('Buy');
    await expect(dialog.locator('[data-market-towin]')).toContainText('If yes wins');
    await dialog.locator('.bets-dialog__chip', { hasText: '5' }).first().click();
    await expect(dialog.locator('[data-market-amount]')).toHaveValue('5');
    await expect(dialog.locator('[data-market-towin]')).toContainText('If yes wins');
    // Back lands on the bet's overview (its question), the No button goes to the form again.
    await dialog.getByRole('button', { name: 'Back' }).click();
    await expect(dialog.locator('.cb-dialog__title')).toHaveText(QUESTION);
    await dialog.locator('.bets-dialog__footer .btn-market-no').click();
    await expect(dialog.locator('.cb-dialog__title')).toHaveText('Bet no');
  });

  // The trade receipt: the sheet stays open under the dialog, the dialog shows confirmed shares
  // and market data, and the row behind it is refreshed, marked and carries the
  // wallet's own bet. Before this, the first press in the dialog closed the sheet (an "outside click")
  // and the dialog removed itself 300 ms after confirming, so a bet ended on the bare map.
  test('a confirmed LMSR buy shows its receipt over the sheet and the changed row behind it', async ({ mockApi: page }) => {
    fileContest(page);
    await captureClipboard(page);
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await page.locator('#bets-button').click();
    await waitForBlockchainRuntime(page, ['SolanaMarketBridge', 'solanaWeb3']);
    await page.evaluate((account) => {
      const bridge = (window as any).SolanaMarketBridge;
      const market = { model: 'lmsr', asset: 'devnet-usdc', b: '100000000', qYes: '250000', qNo: '100000',
        seed: '69314720', closesAt: Math.floor(Date.parse('2026-12-31T00:00:00Z') / 1000), graceSeconds: 0,
        maxPosition: '0', paidOut: '0', creator: 'sponsor', resolved: false, outcome: null };
      (window as any).__buys = [];
      let noShares = 50000n;
      bridge.buy = async (options: any) => {
        (window as any).__buys.push({ proposal: options.proposal, side: options.side, shares: String(options.shares), maxCost: String(options.maxCost) });
        noShares += BigInt(options.shares);
        options.onStatus?.({ state: 'confirmed', signature: 'sig', explorerUrl: 'https://explorer.solana.com/tx/sig?cluster=devnet' });
        return { transactionHash: 'sig', explorerUrl: 'https://explorer.solana.com/tx/sig?cluster=devnet' };
      };
      bridge.readSummary = async () => ({ market, marketAddress: 'market', wallet: 'w', chainStatus: 'active', deadline: '2026-12-31T00:00:00Z', sponsor: 'sponsor', yes: null, no: { side: 0, amount: 50000n, claimed: false } });
      bridge.readPositions = async () => ({ [account]: { yes: null, no: { side: 0, amount: noShares, claimed: false } } });
      bridge.readStakeBalance = async () => 12_500_000n;
    }, ACCOUNT);
    const row = page.locator('#bets-sheet .bets-row').first();
    await row.locator('.btn-market-no').click();
    const dialog = page.locator('#proposalMarketOverlay');
    // The wallet's balance fills "Max".
    await expect(dialog.locator('.bets-dialog__chip', { hasText: 'Max' })).toContainText('12.5');
    await dialog.locator('[data-market-amount]').fill('0.05');
    await dialog.locator('[data-market-submit]').click();
    await expect(dialog.locator('.cb-dialog__title')).toHaveText('Bet placed');
    // The contract receives exact atomic share quantity and the quoted maximum cost.
    await expect.poll(() => page.evaluate(() => (window as any).__buys)).toHaveLength(1);
    const buy = await page.evaluate(() => (window as any).__buys[0]);
    expect(buy).toMatchObject({ proposal: ACCOUNT, side: 0, maxCost: '50000' });
    expect(BigInt(buy.shares)).toBeGreaterThan(0n);
    await expect(dialog.locator('.bets-dialog__facts')).toContainText('Shares');
    await expect(dialog.locator('.bets-dialog__facts')).toContainText('Maximum cost');
    await expect(dialog.locator('.bets-dialog__facts')).toContainText('Payout if this side wins');
    await expect(page.locator('#bets-sheet')).toBeVisible();
    await expect(row).toHaveClass(/is-updated/);
    await expect(row.locator('.bets-row__mine')).toContainText('Your bets: no 0.150074 shares');
    // The receipt carries the bet's link beside Done.
    await dialog.getByRole('button', { name: 'Copy link', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__copied)).toEqual([await expectedLink(page)]);
    await dialog.locator('[data-market-done]').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#bets-sheet')).toBeVisible();
  });

  test('a connected wallet skips the wallet step', async ({ mockApi: page }) => {
    fileContest(page);
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await page.locator('#bets-button').click();
    await page.locator('#bets-sheet .bets-row').first().locator('.btn-market-no').click();
    await expect(page.locator('#proposalMarketOverlay')).toBeVisible();
    await expect(page.locator('#proposalMarketOverlay .cb-dialog__title')).toHaveText('Bet no');
  });

  test('finishing the initial page load preserves a stake form opened through the No button', async ({ mockApi: page }) => {
    // Hold an actual nonessential page resource at the network boundary: the icon font, which the
    // first paint requests (the logo image is lazy since f60ef1e39 and no longer delays load).
    // DOMContentLoaded and the map remain usable, while the browser's real window load event cannot
    // fire yet.
    let releaseImage!: () => void;
    const imageReady = new Promise<void>(resolve => { releaseImage = resolve; });
    await page.route('**/webfonts/fa-solid-900.woff2', async route => {
      await imageReady;
      await route.continue();
    });
    fileContest(page);
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    try {
      await openCity(page);
      await connectWalletByConnectorId(page, 'solana-phantom');
      await page.locator('#bets-button').click();
      await page.locator('#bets-sheet .bets-row').first().locator('.btn-market-no').click();
      const form = page.locator('#proposalMarketOverlay');
      await expect(form.locator('.cb-dialog__title')).toHaveText('Bet no');
      await form.locator('[data-market-amount]').fill('0.25');
      expect(await page.evaluate(() => document.readyState)).toBe('interactive');
      releaseImage();
      await page.waitForLoadState('load');
      await expect(form.locator('.cb-dialog__title')).toHaveText('Bet no');
      await expect(form.locator('[data-market-amount]')).toHaveValue('0.25');
    } finally {
      releaseImage();
    }
  });

  // A shared bet link opens the dated question, LMSR price and terms; the first-visit explainer stays out of
  // the way. "Copy link" there puts the same link (the shareable path form, with the city) on the
  // clipboard, and the rivals button leads back to the contest in the list.
  test('a bet link opens the bet dialog, which copies that link and leads back to its contest', async ({ mockApi: page }) => {
    const { contest } = fileContest(page);
    await captureClipboard(page);
    await page.goto(`/?city=zg&bets=${ACCOUNT}&reduceMotion=1`);
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#site-intro-modal')).toBeHidden();
    await expect(dialog.locator('.cb-dialog__title')).toHaveText(QUESTION);
    await expect(dialog.locator('.bets-dialog__eyebrow')).toContainText('Parcel 2311');
    await expect(dialog.locator('.bets-dialog__chance-word')).toContainText('YES price');
    const facts = dialog.locator('.bets-dialog__facts');
    await expect(facts).toContainText('Liquidity setting');
    await expect(facts).toContainText('Bet deadline');
    await expect(facts).toContainText('Pays');
    await expect(facts).toContainText('densifier-01');
    await expect(dialog.locator('.bets-dialog__rule')).toContainText('YES if this agreement executes on-chain by');
    // The pool's account and the agreement's account on the explorer.
    const links = dialog.locator('.bets-dialog__links a');
    await expect(links).toHaveCount(3);
    await expect(links.nth(1)).toHaveAttribute('href', `https://explorer.solana.com/address/${ACCOUNT}?cluster=devnet`);
    await expect(dialog.locator('.bets-dialog__footer .btn-market-yes')).toContainText('Pays 1.');
    await expect(dialog.locator('.bets-dialog__footer').getByRole('button', { name: 'Open the agreement', exact: true })).toBeVisible();
    await dialog.locator('.bets-dialog__footer').getByRole('button', { name: 'Copy link' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__copied)).toEqual([await expectedLink(page)]);
    await expect(dialog.locator('.bets-dialog__contest')).toHaveText('2 agreements on this land');
    await dialog.locator('.bets-dialog__contest').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#bets-sheet')).toBeVisible();
    await expect(page.locator(`#bets-sheet .bets-contest[data-contest-id="${contest}"]`)).toBeVisible();
    // The row's title opens the dialog again; while it is open the bet's own address stands in the
    // address bar (so a link copied from there unfurls like "Copy link"), and closing puts the app
    // address back.
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/');
    await page.locator('#bets-sheet .bets-row__title').first().click();
    await expect(page.locator('#proposalMarketOverlay .cb-dialog__title')).toHaveText(QUESTION);
    await expect.poll(() => addressWithoutView(page)).toBe(`/bets/${ACCOUNT}?city=zg&reduceMotion=1`);
    await page.locator('#proposalMarketOverlay .close-circle-btn').click();
    await expect.poll(() => addressWithoutView(page)).toBe('/?city=zg&reduceMotion=1');
  });

  test('the path form of a bet link opens the dialog too', async ({ mockApi: page }) => {
    fileContest(page);
    await page.goto(`/bets/${ACCOUNT}?city=zg&reduceMotion=1`);
    await expect(page.locator('#proposalMarketOverlay .cb-dialog__title')).toHaveText(QUESTION, { timeout: 30_000 });
  });

  // LMSR prices remain defined even if no shares have yet been bought on the other side.
  test('one-sided LMSR inventory keeps a finite quote instead of implying certainty', async ({ mockApi: page }) => {
    fileContest(page, { ...OPEN_POOL, qNo: '0' });
    await page.goto(`/?city=zg&bets=${ACCOUNT}&reduceMotion=1`);
    await expect(page.locator('#proposalMarketOverlay .bets-dialog__chance-word')).toContainText('YES price', { timeout: 30_000 });
    await expect(page.locator('#proposalMarketOverlay .bets-dialog__chance-word')).not.toContainText('100');
    await page.locator('#proposalMarketOverlay .close-circle-btn').click();
    await page.locator('#bets-button').click();
    await expect(page.locator('#bets-sheet .bets-row__chance').first()).toContainText('YES price');
  });

  // A VOID resolution makes both sides eligible for half-share claims.
  test('a settled VOID market offers claims for both sides', async ({ mockApi: page }) => {
    fileContest(page, { ...OPEN_POOL, resolved: true, outcome: 'void' }, 'cancelled');
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await waitForBlockchainRuntime(page, ['SolanaMarketBridge', 'solanaWeb3']);
    await page.evaluate((account) => {
      const bridge = (window as any).SolanaMarketBridge;
      (window as any).__claims = [];
      const claimed = new Set<number>();
      bridge.readPositions = async () => ({ [account]: {
        yes: { side: 1, amount: 100000n, claimed: claimed.has(1) },
        no: { side: 0, amount: 200000n, claimed: claimed.has(0) },
      } });
      bridge.claim = async (options: any) => {
        (window as any).__claims.push([options.proposal, options.side]);
        claimed.add(options.side);
        options.onStatus?.({ state: 'confirmed', signature: 'sig', explorerUrl: 'https://explorer.solana.com/tx/sig?cluster=devnet' });
        return { transactionHash: 'sig', explorerUrl: 'https://explorer.solana.com/tx/sig?cluster=devnet' };
      };
    }, ACCOUNT);
    await page.locator('#bets-button').click();
    const row = page.locator('#bets-sheet .bets-row').first();
    await expect(row.locator('.bets-row__chance')).toHaveText('VOID · half paid per share', { timeout: 30_000 });
    await expect(row.locator('.bets-row__mine')).toContainText('Your bets: yes 0.1 shares');
    await expect(row.locator('.bets-row__collect .btn').first()).toHaveText('Collect yes winnings');
    await expect(row.locator('.bets-row__collect .btn')).toHaveCount(2);
    // "Mine" keeps the row; "Open" has nothing.
    await page.locator('#bets-sheet .bets-filter__btn[data-filter="mine"]').click();
    await expect(page.locator('#bets-sheet .bets-row')).toHaveCount(1);
    await page.locator('#bets-sheet .bets-filter__btn[data-filter="open"]').click();
    await expect(page.locator('#bets-sheet-content')).toContainText('No bets match this filter.');
    await page.locator('#bets-sheet .bets-filter__btn[data-filter="all"]').click();
    await page.locator('#bets-sheet .bets-row__title').first().click();
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog.locator('.bets-dialog__chance-word')).toHaveText('VOID · half paid per share');
    await expect(dialog.locator('.bets-dialog__mine')).toContainText('Your bets: yes 0.1 shares');
    const collectButtons = dialog.locator('.bets-dialog__collect .btn');
    await expect(collectButtons).toHaveCount(2);
    await collectButtons.nth(0).click();
    await expect.poll(() => page.evaluate(() => (window as any).__claims)).toHaveLength(1);
    await expect(dialog.locator('[data-market-dialog-status]')).toContainText('Collected');
    await expect(collectButtons).toHaveCount(1);
    await collectButtons.nth(0).click();
    await expect.poll(() => page.evaluate(() => (window as any).__claims)).toHaveLength(2);
    expect(await page.evaluate(() => (window as any).__claims)).toEqual([[ACCOUNT, 1], [ACCOUNT, 0]]);
  });
});
