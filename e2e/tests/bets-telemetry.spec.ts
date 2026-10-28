// Exercise the real betting instrumentation with simulated browser personas and wallet outcomes.
import { test, expect } from '../helpers/fixtures';
import type { Page } from '@playwright/test';
import { validateBetEvents } from '../../backend/routes/bets-events.js';
import { openCity } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockSolanaWallet, waitForBlockchainRuntime } from '../helpers/blockchain';
import { pageIndex } from '../helpers/mocks/shared-server';
import { fileIndexedAgreement, MINTED_ACCOUNT, OPEN_POOL, selectDevnetUsdc } from '../helpers/agreements';

const ACCOUNT = MINTED_ACCOUNT;
const WALLET = 'Cp886ML2Ja4FF3SMmyUeW16rRGsLrBcRW8kfWS1VfN7W';
const TITLE = 'Telemetry test plan';
const ROW_TITLE = `#bets-sheet .bets-row[data-account="${ACCOUNT}"] .bets-row__title`;
const EVENT_FIELDS = new Set([
  'id', 'visitorId', 'sessionId', 'actorMode', 'simulationRun', 'occurredAt', 'name', 'city',
  'agreementAccount', 'agreementCid', 'action', 'side', 'result', 'asset', 'entryPoint', 'errorCode',
]);

type CapturedEvents = { events: any[]; validationErrors: string[] };

// Let the production BetsTelemetry client send real batches, while the browser boundary validates
// the same event contract the API accepts and acknowledges exactly the batch it received.
async function captureTelemetry(page: Page): Promise<CapturedEvents> {
  const capture: CapturedEvents = { events: [], validationErrors: [] };
  await page.route('**/bets/events', async route => {
    let batch: any;
    try { batch = route.request().postDataJSON(); } catch (_) { batch = null; }
    const events = batch?.events;
    const errors: string[] = [];
    if (!Array.isArray(events) || events.length < 1 || events.length > 20) errors.push('invalid batch size');
    for (const event of Array.isArray(events) ? events : []) {
      if (!event || typeof event !== 'object' || Object.keys(event).some(key => !EVENT_FIELDS.has(key))) errors.push('unsupported event shape');
      if (event?.actorMode !== 'simulated') errors.push('event was not marked simulated');
      if (!['local-preview', 'browser-automation'].includes(event?.simulationRun) && !/^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/.test(event?.simulationRun || '')) errors.push('invalid simulation run');
      if (!event?.visitorId || !event?.sessionId || !event?.id) errors.push('missing event identity');
      if (!Number.isFinite(Date.parse(event?.occurredAt))) errors.push('invalid event time');
    }
    const validation = validateBetEvents(batch);
    if (validation.error) errors.push(validation.error);
    capture.validationErrors.push(...errors);
    if (errors.length) {
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: errors[0] }) });
      return;
    }
    capture.events.push(...events);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accepted: events.length }) });
  });
  return capture;
}

function fileOpenContest(page: Page): void {
  fileIndexedAgreement(pageIndex(page), { title: TITLE, minted: { status: 'active' }, pool: OPEN_POOL });
  fileIndexedAgreement(pageIndex(page), { title: 'Alternative public garden' });
}

async function flushTelemetry(page: Page): Promise<void> {
  await page.evaluate(async () => { await (window as any).BetsTelemetry.flush(); });
}

function assertNoWalletPayload(capture: CapturedEvents): void {
  expect(capture.validationErrors).toEqual([]);
  const serialized = JSON.stringify(capture.events);
  expect(serialized).not.toContain(WALLET);
  for (const event of capture.events) {
    expect(Object.keys(event).every(key => EVENT_FIELDS.has(key))).toBe(true);
    expect(event.actorMode).toBe('simulated');
    expect(['local-preview', 'browser-automation']).toContain(event.simulationRun);
    expect(event.city).toBe('zg');
    expect(Date.parse(event.occurredAt)).not.toBeNaN();
  }
}

test.describe('Betting journey telemetry @features', () => {
  test.beforeEach(async ({ mockApi: page }) => { await selectDevnetUsdc(page); });
  test('a curious resident discovers a market, shares it, returns, closes, then hits the wallet gate', async ({ mockApi: page }) => {
    fileOpenContest(page);
    const captured = await captureTelemetry(page);
    await page.addInitScript(() => {
      (window as any).__copied = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { (window as any).__copied.push(text); } },
      });
    });
    await openCity(page);
    await page.locator('#bets-button').click();
    const sheet = page.locator('#bets-sheet');
    await expect(sheet.locator(`.bets-row[data-account="${ACCOUNT}"]`)).toHaveCount(1, { timeout: 30_000 });
    await page.locator(ROW_TITLE).click();
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog).toBeVisible();
    await expect.poll(() => captured.events.some(event => event.name === 'market_open' && event.agreementAccount === ACCOUNT)).toBe(true);

    await dialog.locator('.bets-dialog__footer').getByRole('button', { name: 'Copy link' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__copied.length)).toBe(1);
    await dialog.locator('.bets-dialog__contest').click();
    await expect(dialog).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await page.locator(ROW_TITLE).click();
    await page.locator('#proposalMarketOverlay .close-circle-btn').click();
    await expect(page.locator('#proposalMarketOverlay')).toHaveCount(0);

    await page.locator('#bets-sheet .bets-row').first().locator('.btn-market-yes').click();
    await expect(page.locator('.wallet-modal-overlay')).toBeVisible();
    await flushTelemetry(page);
    assertNoWalletPayload(captured);
    const events = captured.events;
    expect(events.filter(event => event.name === 'entry')).toHaveLength(1);
    expect(events.filter(event => event.name === 'discovery' && event.result === 'succeeded')).toHaveLength(2);
    expect(events.filter(event => event.name === 'market_open' && event.agreementAccount === ACCOUNT)).toHaveLength(2);
    expect(events.filter(event => event.name === 'share' && event.result === 'succeeded')).toHaveLength(1);
    expect(events.filter(event => event.name === 'return')).toHaveLength(1);
    expect(events.filter(event => event.name === 'close').length).toBeGreaterThanOrEqual(2);
    expect(events.filter(event => event.name === 'action_start' && event.action === 'buy' && event.result === 'started')).toHaveLength(1);
    expect(events.filter(event => event.name === 'action_end' && event.action === 'buy' && event.result === 'failed' && event.errorCode === 'wallet_not_connected')).toHaveLength(1);
  });

  test('a connected trader quotes a quick buy and records an uncertain confirmation with agreement context', async ({ mockApi: page }) => {
    fileOpenContest(page);
    await injectMockSolanaWallet(page, { publicKey: WALLET, providerName: 'phantom' });
    const captured = await captureTelemetry(page);
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await page.locator('#bets-button').click();
    await waitForBlockchainRuntime(page, ['SolanaMarketBridge', 'solanaWeb3']);
    await page.evaluate(() => {
      const bridge = (window as any).SolanaMarketBridge;
      bridge.readSummary = async () => ({
        market: { ...OPEN_POOL, resolved: false, outcome: null },
        marketAddress: 'test-market', chainStatus: 'Active',
      });
      bridge.readPositions = async () => ({});
      bridge.readStakeBalance = async () => 12_500_000n;
      bridge.buy = async (options: any) => {
        options.onStatus?.({ state: 'preparing' });
        options.onStatus?.({ state: 'awaiting_signature' });
        options.onStatus?.({ state: 'submitted', signature: 'tx-signature' });
        const error = new Error('confirmation status is unknown') as Error & { code: string };
        error.code = 'CONFIRMATION_UNKNOWN';
        throw error;
      };
    });
    await page.locator('#bets-sheet .bets-row').first().locator('.btn-market-yes').click();
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog.locator('.cb-dialog__title')).toHaveText('Bet yes');
    await dialog.locator('.bets-dialog__chip').filter({ hasText: /^1$/ }).click();
    await dialog.locator('[data-market-submit]').click();
    await expect(dialog.locator('[data-market-dialog-status]')).toContainText(/unknown|failed|confirm/i);
    await dialog.locator('.close-circle-btn').click();
    await expect(dialog).toHaveCount(0);
    await flushTelemetry(page);
    assertNoWalletPayload(captured);
    const events = captured.events;
    expect(events.filter(event => event.name === 'quote' && event.action === 'buy' && event.side === 'yes' && event.agreementAccount === ACCOUNT)).toHaveLength(2);
    expect(events.filter(event => event.name === 'action_start' && event.action === 'buy' && event.side === 'yes' && event.agreementAccount === ACCOUNT)).toHaveLength(1);
    expect(events.filter(event => event.name === 'action_status' && event.action === 'buy' && event.result === 'submitted' && event.agreementAccount === ACCOUNT)).toHaveLength(1);
    expect(events.filter(event => event.name === 'action_end' && event.action === 'buy' && event.result === 'unknown' && event.errorCode === 'confirmation_unknown' && event.agreementAccount === ACCOUNT)).toHaveLength(1);
    expect(events.filter(event => event.name === 'close' && event.agreementAccount === ACCOUNT)).toHaveLength(1);
  });

  test('a trader collects a resolved winning position through the dialog and records a confirmed claim', async ({ mockApi: page }) => {
    fileIndexedAgreement(pageIndex(page), {
      title: TITLE, minted: { status: 'executed' }, pool: { ...OPEN_POOL, resolved: true, outcome: 'yes' },
    });
    await injectMockSolanaWallet(page, { publicKey: WALLET, providerName: 'phantom' });
    const captured = await captureTelemetry(page);
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await page.locator('#bets-button').click();
    await waitForBlockchainRuntime(page, ['SolanaMarketBridge', 'solanaWeb3']);
    await page.evaluate((account) => {
      const bridge = (window as any).SolanaMarketBridge;
      let claimed = false;
      bridge.readSummary = async () => ({
        market: { ...OPEN_POOL, resolved: true, outcome: 'yes' },
        marketAddress: 'test-market', chainStatus: 'Executed',
      });
      bridge.readPositions = async () => ({ [account]: { yes: { side: 1, amount: 100000n, claimed }, no: null } });
      bridge.claim = async (options: any) => {
        options.onStatus?.({ state: 'submitted', signature: 'claim-signature' });
        options.onStatus?.({ state: 'confirmed', signature: 'claim-signature' });
        claimed = true;
        return { transactionHash: 'claim-signature', explorerUrl: 'https://explorer.solana.com/tx/claim-signature?cluster=devnet' };
      };
    }, ACCOUNT);
    await page.evaluate(async () => { await (window as any).BetsSheet.load({ force: true }); await (window as any).BetsSheet.whenPositions(); });
    await page.locator(ROW_TITLE).click();
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog.locator('.bets-dialog__collect .btn')).toHaveText('Collect yes winnings');
    await dialog.locator('.bets-dialog__collect .btn').click();
    await expect(dialog.locator('[data-market-dialog-status]')).toContainText('Collected yes winnings.');
    await expect(dialog.locator('.bets-dialog__collect .btn')).toHaveCount(0);
    await flushTelemetry(page);
    assertNoWalletPayload(captured);
    expect(captured.events.filter(event => event.name === 'action_start' && event.action === 'claim' && event.side === 'yes' && event.agreementAccount === ACCOUNT)).toHaveLength(1);
    expect(captured.events.filter(event => event.name === 'action_status' && event.action === 'claim' && event.result === 'confirmed' && event.agreementAccount === ACCOUNT)).toHaveLength(1);
    expect(captured.events.filter(event => event.name === 'action_end' && event.action === 'claim' && event.result === 'confirmed' && event.agreementAccount === ACCOUNT)).toHaveLength(1);
  });
});
