// Exercise the Bets sheet and dialog actions through their real navigation and wallet boundaries.
import { test, expect } from '../helpers/fixtures';
import { createSpace, openCity, showProposal } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockSolanaWallet } from '../helpers/blockchain';
import { attachSharedProposalServer, createSharedProposalServer } from '../helpers/mocks/shared-server';

const ACCOUNT = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';
const WALLET = 'Cp886ML2Ja4FF3SMmyUeW16rRGsLrBcRW8kfWS1VfN7W';

function payload(entry: Record<string, unknown> = {}) {
  const proposal = {
    id: 789, proposalId: 'minted-one', title: 'Plan-led infill', goal: 'single', lifecycleStatus: 'Active',
    createdAt: '2026-10-01T09:30:00Z', expiresAt: null, author: 'densifier-01', agent: true,
    proposalRole: null, screenshotUrl: null, parcelIds: ['HR-335614-2311'], proposalAccount: ACCOUNT,
    bettable: true, canOpenMarket: false,
    market: { address: 'HQqbGtviQr5KRs4x8CWSCVhnkrLKDiYqXmVSBY8GZdfw', yesPool: '250000', noPool: '50000', poolAtomic: '300000', resolved: false, outcome: null },
    ...entry,
  };
  return {
    city: 'zagreb', generatedAt: '2026-10-09T07:00:00.000Z', cluster: 'devnet', stakeDecimals: 6,
    marketProgram: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB', stakeMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    summary: { contests: 1, proposals: 1, markets: proposal.market ? 1 : 0, openMarkets: proposal.bettable ? 1 : 0, poolAtomic: '300000' },
    contests: [{ id: 'c-test', parcelIds: ['HR-335614-2311'], proposalCount: 1, mintedCount: 1,
      marketCount: proposal.market ? 1 : 0, openMarketCount: proposal.bettable ? 1 : 0,
      poolAtomic: '300000', latestCreatedAt: '2026-10-02T00:00:00Z', proposals: [proposal] }],
  };
}

async function routeMarkets(page: import('@playwright/test').Page, data = payload()): Promise<void> {
  await page.route('**/markets?*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }));
}

async function captureShareAndClipboard(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__betsShare = null;
    (window as any).__betsClipboard = [];
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => { (window as any).__betsShare = data; } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__betsClipboard.push(text); } } });
  });
}

test.describe('Bets shared button variants @features', () => {
  test('Try again reloads a failed Bets request and renders the recovered contest', async ({ mockApi: page }) => {
    let attempts = 0;
    await page.route('**/markets?*', route => {
      attempts += 1;
      return attempts === 1
        ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporary"}' })
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload()) });
    });
    await openCity(page);
    await page.locator('#bets-button').click();
    const content = page.locator('#bets-sheet-content');
    await expect(content).toContainText('Bets could not be loaded.');
    await content.getByRole('button', { name: 'Try again' }).click();
    await expect(content.locator('.bets-row__title')).toHaveText('Plan-led infill');
    expect(attempts).toBe(2);
  });

  test('Share and Copy link use the bet URL from the overview and the sheet row', async ({ mockApi: page }) => {
    await routeMarkets(page);
    await captureShareAndClipboard(page);
    await page.goto(`/?city=zg&bets=${ACCOUNT}&reduceMotion=1`);
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog.locator('.cb-dialog__title')).toHaveText('Plan-led infill');
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

  test('Open proposal closes Bets and shows the proposal details', async ({ mockApi: page }) => {
    await openCity(page);
    const proposalId = await createSpace(page, 'park');
    const title = await page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.title, proposalId);
    await routeMarkets(page, payload({ id: proposalId, proposalId, title }));
    await page.locator('#bets-button').click();
    await page.locator('#bets-sheet .bets-row__title').click();
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Open proposal', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#bets-sheet')).toBeHidden();
    await expect(page.locator('#proposal-details-panel')).toBeVisible();
    await expect(page.locator('#proposal-details-panel')).toContainText(title);
  });

  test('Open the plan resolves its named-plan route and applies the published member', async ({ mockApi: page }) => {
    const server = createSharedProposalServer();
    const slug = 'bets-open-plan-test';
    await attachSharedProposalServer(page, server);
    await page.route(`**/plans/${slug}`, route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ slug, title: 'Bets named plan', city: 'zagreb', proposalIds: [...server.records.keys()] }),
    }));
    await openCity(page);
    await page.locator('#username-display').click();
    await expect(page.locator('#welcome-modal')).toBeVisible();
    await page.locator('#username-input').fill('Bets named-plan tester');
    await page.locator('#welcome-submit-btn').click();
    await expect(page.locator('#welcome-modal')).toBeHidden();

    const localId = await createSpace(page, 'park');
    const title = await page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.title, localId);
    await showProposal(page, localId);
    await page.locator('#proposal-details-panel .btn-share-proposal').click();
    const share = page.locator('.share-modal-overlay');
    await expect(share).toBeVisible();
    await share.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(share.locator('.share-modal-link').first()).toHaveValue(/\/proposals\/\d+\?/);
    const serverId = [...server.records.keys()][0];
    expect(serverId).toBeTruthy();
    // Upload leaves its success screen open. Dismiss that real share dialog before opening Bets,
    // otherwise its full-screen overlay intercepts the shell button click.
    await share.locator('.share-modal-close').click();
    await expect(share).toBeHidden();

    await routeMarkets(page, payload({
      id: `plan:${slug}`, kind: 'plan', planSlug: slug, proposalId: slug,
      title: 'Bets named plan', memberCount: 1,
      members: [{ id: serverId, proposalId: title, title: String(title), goal: 'park' }],
      proposalAccount: ACCOUNT, bettable: true,
    }));
    await page.locator('#bets-button').click();
    await page.locator('#bets-sheet .bets-row__title').click();
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Open the plan', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#bets-sheet')).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).__currentNamedPlan?.slug), { timeout: 30_000 }).toBe(slug);
    await expect.poll(() => page.evaluate(() => new URL(location.href).pathname)).toBe(`/proposals/${slug}`);
  });

  test('the dialog Yes button opens a Yes stake form, and quick stakes set the entered amount', async ({ mockApi: page }) => {
    await routeMarkets(page);
    await injectMockSolanaWallet(page, { publicKey: WALLET, providerName: 'phantom' });
    await page.route('https://api.devnet.solana.com/**', async route => {
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: {
          'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        } });
      }
      let request: any = {};
      try { request = route.request().postDataJSON(); } catch (_) { }
      let result: unknown;
      if (request.method === 'getTokenAccountBalance') {
        result = { context: { slot: 1 }, value: { amount: '12500000', decimals: 6, uiAmount: 12.5, uiAmountString: '12.5' } };
      } else if (request.method === 'getAccountInfo') {
        result = { context: { slot: 1 }, value: null };
      } else if (request.method === 'getMultipleAccounts') {
        const pubkeys = Array.isArray(request.params?.[0]) ? request.params[0] : [];
        result = { context: { slot: 1 }, value: pubkeys.map(() => null) };
      }
      if (result !== undefined) {
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({
          jsonrpc: '2.0', id: request.id, result,
        }) });
      }
      return route.continue();
    });
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await page.goto(`/?city=zg&bets=${ACCOUNT}&reduceMotion=1`);
    const dialog = page.locator('#proposalMarketOverlay');
    await dialog.locator('.bets-dialog__footer .btn-market-yes').click();
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

  for (const action of [
    { name: 'Open the pool', row: { bettable: false, canOpenMarket: true, market: null, lifecycleStatus: 'Active' } },
    { name: 'Settle the pool', row: { bettable: false, canOpenMarket: false, lifecycleStatus: 'Executed', market: { address: 'HQqbGtviQr5KRs4x8CWSCVhnkrLKDiYqXmVSBY8GZdfw', yesPool: '250000', noPool: '50000', poolAtomic: '300000', resolved: false, outcome: null } } },
  ]) {
    test(`${action.name} requests a wallet before the pool transaction`, async ({ mockApi: page }) => {
      await routeMarkets(page, payload(action.row));
      await openCity(page);
      await page.locator('#bets-button').click();
      const rowButton = page.locator('#bets-sheet .bets-row__actions').getByRole('button', { name: action.name, exact: true });
      await expect(rowButton).toBeVisible();
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
