// Exercise the Bets sheet and dialog actions through their real navigation and wallet boundaries
// (plan-design-agreement.md, M3: a bet is on a minted agreement, its row and dialog lead to the
// agreement's panel). The city's contests come from the page's index (mocks/shared-server.ts).
import { test, expect } from '../helpers/fixtures';
import type { Page } from '@playwright/test';
import { openCity } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockSolanaWallet } from '../helpers/blockchain';
import { pageIndex, MarketPool } from '../helpers/mocks/shared-server';
import { fileIndexedAgreement, proposeOverPark, storedAgreements, MINTED_ACCOUNT, OPEN_POOL } from '../helpers/agreements';

const ACCOUNT = MINTED_ACCOUNT;
const WALLET = 'Cp886ML2Ja4FF3SMmyUeW16rRGsLrBcRW8kfWS1VfN7W';
const TITLE = 'Plan-led infill';

// A binding agreement over parcel 2311 proposed in Zagreb, minted at ACCOUNT, as the index holds it:
// `status` is the account's status the index recorded, `pool` its market (none: no pool opened yet).
const fileMinted = (page: Page, { status = 'active', pool = OPEN_POOL }: { status?: string; pool?: MarketPool | null } = {}) =>
  fileIndexedAgreement(pageIndex(page), { title: TITLE, designTitles: ['Infill park'], minted: { status }, pool }).cid;

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
    await expect(dialog.locator('.cb-dialog__title')).toHaveText(`Will ${TITLE} execute on-chain?`, { timeout: 30_000 });
    const expected = await page.evaluate(account => `${location.origin}/bets/${account}?city=zagreb`, ACCOUNT);
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
      await expect(dialog.locator('.cb-dialog__title')).toHaveText(`Will ${title} execute on-chain?`);
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
    await expect(dialog.locator('.cb-dialog__title')).toHaveText(`Will ${title} execute on-chain?`);
    await dialog.locator('.close-circle-btn').click();
    await expect(dialog).toHaveCount(0);
    await panel.locator('[data-agreement-action="close"]').click();
    await expect(panel).toBeHidden();

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

  test('the dialog Yes button opens a Yes stake form, and quick stakes set the entered amount', async ({ mockApi: page }) => {
    fileMinted(page);
    await injectMockSolanaWallet(page, { publicKey: WALLET, providerName: 'phantom' });
    let mockedBalanceRequests = 0;
    await routeSolanaReads(page, () => { mockedBalanceRequests += 1; });
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await page.goto(`/?city=zg&bets=${ACCOUNT}&reduceMotion=1`);
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
    await expect.poll(() => mockedBalanceRequests).toBeGreaterThan(0);
    await expect(dialog.locator('[data-market-amount]')).toHaveValue('12.5');
  });

  test('Submit a Yes stake sends the entered amount to the wallet bridge and shows the receipt', async ({ mockApi: page }) => {
    fileMinted(page);
    await injectMockSolanaWallet(page, { publicKey: WALLET, providerName: 'phantom' });
    await routeSolanaReads(page);
    await page.addInitScript(() => {
      (window as any).__stakeCalls = [];
      // Replace only the transaction boundary; the dialog still validates and submits its form.
      const install = () => {
        const bridge = (window as any).SolanaMarketBridge;
        if (!bridge || typeof bridge.stake !== 'function') return false;
        bridge.stake = async (args: any) => {
          (window as any).__stakeCalls.push({ proposal: args.proposal, side: args.side, amount: String(args.amount) });
          return { explorerUrl: 'https://explorer.solana.com/tx/mock?cluster=devnet' };
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
    await expect.poll(() => page.evaluate(() => (window as any).__stakeCalls)).toEqual([
      { proposal: ACCOUNT, side: 1, amount: '2500000' },
    ]);
    await expect(dialog).toContainText('2.5 USDC on yes is in the pool.');
  });

  for (const action of [
    // Minted and Active, with no pool yet: anyone can open the one pool.
    { name: 'Open the pool', status: 'active', pool: null },
    // Executed on-chain while its pool is still open: anyone can settle it.
    { name: 'Settle the pool', status: 'executed', pool: OPEN_POOL },
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
});
