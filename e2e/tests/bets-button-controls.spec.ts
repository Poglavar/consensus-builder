// Exercise the Bets sheet and dialog actions through their real navigation and wallet boundaries
// (plan-design-agreement.md, M3: a bet is on a minted agreement, its row and dialog lead to the
// agreement's panel). The city's contests come from the page's index (mocks/shared-server.ts).
import { test, expect } from '../helpers/fixtures';
import type { Page } from '@playwright/test';
import { openCity } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockSolanaWallet, waitForBlockchainRuntime } from '../helpers/blockchain';
import { pageIndex, MarketFixture } from '../helpers/mocks/shared-server';
import { closeAgreementPanel, fileIndexedAgreement, proposeOverPark, storedAgreements, MINTED_ACCOUNT, OPEN_POOL, selectDevnetUsdc } from '../helpers/agreements';

const ACCOUNT = MINTED_ACCOUNT;
const WALLET = 'Cp886ML2Ja4FF3SMmyUeW16rRGsLrBcRW8kfWS1VfN7W';
const TITLE = 'Plan-led infill';

// A binding agreement over parcel 2311 proposed in Zagreb, minted at ACCOUNT, as the index holds it:
// `status` is the account's status the index recorded, `pool` its market (none: no pool opened yet).
const fileMinted = (page: Page, { status = 'active', pool = OPEN_POOL, sponsor }: { status?: string; pool?: MarketFixture | null; sponsor?: string } = {}) =>
  fileIndexedAgreement(pageIndex(page), { title: TITLE, designTitles: ['Infill park'], minted: { status, sponsor }, pool }).cid;

// Solana reads answered locally: devnet's genesis, no accounts, and an optional stake balance.
async function routeSolanaReads(page: Page, onBalance?: () => void): Promise<void> {
  await page.route('**/*', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    let request: any = {};
    try { request = route.request().postDataJSON(); } catch (_) { }
    let result: unknown;
    if (request?.method === 'getGenesisHash') {
      // getVerifiedConnection refuses reads unless the endpoint identifies as Solana devnet.
      result = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    } else if (request?.method === 'getTokenAccountBalance' && onBalance) {
      onBalance();
      result = { context: { slot: 1 }, value: { amount: '12500000', decimals: 6, uiAmount: 12.5, uiAmountString: '12.5' } };
    } else if (request?.method === 'getAccountInfo') {
      result = { context: { slot: 1 }, value: null };
    } else if (request?.method === 'getMultipleAccounts') {
      const pubkeys = Array.isArray(request.params?.[0]) ? request.params[0] : [];
      result = { context: { slot: 1 }, value: pubkeys.map(() => null) };
    }
    if (result === undefined) return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({
      jsonrpc: '2.0', id: request.id, result,
    }) });
  });
}

async function captureShareAndClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__betsShare = null;
    (window as any).__betsClipboard = [];
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => { (window as any).__betsShare = data; } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__betsClipboard.push(text); } } });
  });
}

test.describe('Bets shared button variants @features', () => {
  test.beforeEach(async ({ mockApi: page }) => { await selectDevnetUsdc(page); });
  test('Try again reloads a failed Bets request and renders the recovered contest', async ({ mockApi: page }) => {
    fileMinted(page);
    let attempts = 0;
    // The first read fails; the next ones reach the index.
    await page.route('**/markets?*', route => {
      attempts += 1;
      return attempts === 1
        ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporary"}' })
        : route.fallback();
    });
    await openCity(page);
    await page.locator('#bets-button').click();
    const content = page.locator('#bets-sheet-content');
    await expect(content).toContainText('Bets could not be loaded.', { timeout: 30_000 });
    await content.getByRole('button', { name: 'Try again' }).click();
    await expect(content.locator('.bets-row__title')).toHaveText(TITLE, { timeout: 30_000 });
    expect(attempts).toBe(2);
  });

  test('Share and Copy link use the bet URL from the overview and the sheet row', async ({ mockApi: page }) => {
    fileMinted(page);
    await captureShareAndClipboard(page);
    await page.goto(`/?city=zg&bets=${ACCOUNT}&reduceMotion=1`);
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog.locator('.cb-dialog__title')).toContainText(`Will ${TITLE} execute by`, { timeout: 30_000 });
    const expected = await page.evaluate(account => `${location.origin}/bets/${account}?city=zagreb&asset=devnet-usdc&betTest=local-preview`, ACCOUNT);
    await dialog.getByRole('button', { name: 'Share', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__betsShare?.url)).toBe(expected);
    await dialog.getByRole('button', { name: 'Copy link', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__betsClipboard)).toEqual([expected]);
    await dialog.locator('.close-circle-btn').click();
    await page.locator('#bets-button').click();
    await page.locator('#bets-sheet .bets-row__link').click();
    await expect.poll(() => page.evaluate(() => (window as any).__betsClipboard)).toEqual([expected, expected]);
  });

  test('Open the agreement closes Bets and opens the agreement panel, from this device or from the index', async ({ mockApi: page }) => {
    test.setTimeout(150_000);
    // The panel reads the minted account from the chain: no account answers here.
    await routeSolanaReads(page);
    await openCity(page);
    const title = 'Park agreement on bets';
    // A binding owners' agreement over a park applied here, proposed from this device and minted at
    // ACCOUNT with an open pool: what the Bets row and the agreement panel both stand for.
    const { id, cid } = await proposeOverPark(page, { title, author: 'Bets fixture', minted: {}, pool: OPEN_POOL });
    const dialog = page.locator('#proposalMarketOverlay');
    const panel = page.locator('section#agreement-panel');
    const openFromBets = async () => {
      await page.locator('#bets-button').click();
      await page.locator(`#bets-sheet .bets-row[data-cid="${cid}"] .bets-row__title`).click({ timeout: 30_000 });
      await expect(dialog.locator('.cb-dialog__title')).toContainText(`Will ${title} execute by`);
      await dialog.getByRole('button', { name: 'Open the agreement', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('#bets-sheet')).toBeHidden();
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('#agreement-panel-title')).toHaveText(title);
      await expect(panel.locator('code.agreement-panel-cid')).toHaveAttribute('title', cid);
    };

    // This device proposed it: its own record opens.
    await openFromBets();
    let stored = await storedAgreements(page);
    expect(stored.map((agreement: any) => agreement.id)).toEqual([id]);
    // A minted agreement with a pool offers its bet on the panel, back into the same dialog.
    await panel.locator('[data-agreement-action="bet"]').click();
    await expect(dialog.locator('.cb-dialog__title')).toContainText(`Will ${title} execute by`);
    await dialog.locator('.close-circle-btn').click();
    await expect(dialog).toHaveCount(0);
    // Hosted in the click stack the panel has no close button of its own (bfc91e9bf); Escape closes the spot.
    await closeAgreementPanel(page);

    // Without a copy here, the agreement is read from the index and kept, and its panel opens.
    await page.evaluate(id => (window as any).AgreementStore.remove(id), id);
    expect(await storedAgreements(page)).toEqual([]);
    await openFromBets();
    stored = await storedAgreements(page);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ title, published: { cid } });
    // A new record on this device, made from the index's row.
    expect(stored[0].id).not.toBe(id);
  });

  test('the dialog Yes button opens a Yes buy form, and quick amounts update the quote', async ({ mockApi: page }) => {
    fileMinted(page);
    await injectMockSolanaWallet(page, { publicKey: WALLET, providerName: 'phantom' });
    await routeSolanaReads(page);
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await waitForBlockchainRuntime(page, ['SolanaMarketBridge', 'solanaWeb3']);
    await page.evaluate(() => { (window as any).SolanaMarketBridge.readStakeBalance = async () => 12_500_000n; });
    await page.locator('#bets-button').click();
    await page.locator('#bets-sheet .bets-row__title').click();
    const dialog = page.locator('#proposalMarketOverlay');
    await dialog.locator('.bets-dialog__footer .btn-market-yes').click({ timeout: 30_000 });
    await expect(dialog.locator('.cb-dialog__title')).toHaveText('Bet yes');
    for (const amount of ['0.1', '1', '5']) {
      await dialog.locator('.bets-dialog__chip').filter({ hasText: new RegExp(`^${amount}$`) }).click();
      await expect(dialog.locator('[data-market-amount]')).toHaveValue(amount);
    }
    const max = dialog.locator('.bets-dialog__chip').filter({ hasText: /^Max\b/ });
    await expect(max).toBeVisible();
    await max.click();
    await expect(dialog.locator('[data-market-amount]')).toHaveValue('12.5');
  });

  test('Submit a Yes buy sends the quoted shares and cost limit to the wallet bridge', async ({ mockApi: page }) => {
    fileMinted(page);
    await injectMockSolanaWallet(page, { publicKey: WALLET, providerName: 'phantom' });
    await routeSolanaReads(page);
    await page.addInitScript(() => {
      (window as any).__buyCalls = [];
      // Replace only the transaction boundary; the dialog still validates and submits its form.
      const install = () => {
        const bridge = (window as any).SolanaMarketBridge;
        if (!bridge || typeof bridge.buy !== 'function') return false;
        bridge.buy = async (args: any) => {
          (window as any).__buyCalls.push({ proposal: args.proposal, side: args.side, shares: String(args.shares), maxCost: String(args.maxCost) });
          args.onStatus?.({ state: 'confirmed', signature: 'mock', explorerUrl: 'https://explorer.solana.com/tx/mock?cluster=devnet' });
          return { transactionHash: 'mock', explorerUrl: 'https://explorer.solana.com/tx/mock?cluster=devnet' };
        };
        return true;
      };
      const timer = window.setInterval(() => { if (install()) window.clearInterval(timer); }, 0);
    });
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await page.goto(`/?city=zg&bets=${ACCOUNT}&reduceMotion=1`);
    const dialog = page.locator('#proposalMarketOverlay');
    await dialog.locator('.bets-dialog__footer .btn-market-yes').click({ timeout: 30_000 });
    await dialog.locator('[data-market-amount]').fill('2.5');
    await dialog.locator('[data-market-submit]').click();
    await expect.poll(() => page.evaluate(() => (window as any).__buyCalls)).toHaveLength(1);
    const buy = await page.evaluate(() => (window as any).__buyCalls[0]);
    expect(buy).toMatchObject({ proposal: ACCOUNT, side: 1, maxCost: '2500000' });
    expect(BigInt(buy.shares)).toBeGreaterThan(0n);
    await expect(dialog.locator('.cb-dialog__title')).toHaveText('Bet placed');
  });

  for (const action of [
    { name: 'Settle market', status: 'executed', pool: OPEN_POOL },
  ]) {
    test(`${action.name} requests a wallet before the pool transaction`, async ({ mockApi: page }) => {
      fileMinted(page, { status: action.status, pool: action.pool });
      await openCity(page);
      await page.locator('#bets-button').click();
      const rowButton = page.locator('#bets-sheet .bets-row__actions').getByRole('button', { name: action.name, exact: true });
      await expect(rowButton).toBeVisible({ timeout: 30_000 });
      await rowButton.click();
      await expect(page.locator('.wallet-modal-overlay')).toBeVisible();
      await expect(page.locator('.wallet-modal')).toContainText('Select one of the detected wallets to continue.');
      await page.locator('.wallet-modal-overlay [data-wallet-modal-close]').click();
      await page.locator('#bets-sheet .bets-row__title').click();
      const dialog = page.locator('#proposalMarketOverlay');
      await expect(dialog).toBeVisible();
      const footerAction = dialog.locator('.cb-dialog__footer').getByRole('button', { name: action.name, exact: true });
      await expect(footerAction).toBeVisible();
      await footerAction.click();
      await expect(page.locator('.wallet-modal-overlay')).toBeVisible();
    });
  }

  test('only the agreement sponsor sees the control to seed its USDC market', async ({ mockApi: page }) => {
    fileMinted(page, { pool: null, sponsor: WALLET });
    await injectMockSolanaWallet(page, { publicKey: 'AoVsGaj8MSJ6xwKxfFxo9iZWH3enC8RRTXKH2fx2F8os', providerName: 'phantom' });
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await page.locator('#bets-button').click();
    const action = page.locator('#bets-sheet .bets-row__actions').getByRole('button', { name: 'Seed USDC market', exact: true });
    await expect(action).toHaveCount(0);
    await page.evaluate(() => {
      const manager = (window as any).solanaWalletManager;
      const original = manager.getState.bind(manager);
      manager.getState = () => ({ ...original(), accounts: ['Cp886ML2Ja4FF3SMmyUeW16rRGsLrBcRW8kfWS1VfN7W'] });
      return (window as any).BetsSheet.load({ force: true });
    });
    await expect(action).toBeVisible();
  });
});
