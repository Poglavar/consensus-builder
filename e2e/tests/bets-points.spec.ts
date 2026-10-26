import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { spawn, ChildProcess } from 'node:child_process';
import { once } from 'node:events';

let run = '';
const backend = 'http://127.0.0.1:4684';
let harness: ChildProcess;

test.beforeEach(async ({ baseURL }) => {
  run = `e2e-${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  harness = spawn('node', ['backend/scripts/bets-points-preview.mjs'], {
    cwd: process.cwd().replace(/\/e2e$/, ''), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, POINTS_PREVIEW_RUN: run, POINTS_PREVIEW_PORT: '4684', POINTS_PREVIEW_ORIGIN: new URL(baseURL!).origin },
  });
  let output = '';
  harness.stdout?.on('data', chunk => { output += chunk.toString(); });
  harness.stderr?.on('data', chunk => { output += chunk.toString(); });
  for (let i = 0; i < 80; i++) {
    if (harness.exitCode !== null) throw new Error(`Points harness exited: ${output}`);
    try { const response = await fetch(`${backend}/health`); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Points harness did not start: ${output}`);
});
test.afterEach(async ({ page }) => {
  await page.context().close();
  if (!harness || harness.exitCode !== null) return;
  // Subscribe before signalling to avoid missing a fast child exit and leaving Playwright waiting.
  const exited = once(harness, 'exit');
  harness.kill('SIGTERM');
  let timer: NodeJS.Timeout;
  try {
    await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned points harness did not exit after SIGTERM')), 15_000); })]);
  } finally { clearTimeout(timer!); }
});

async function openPointsPreview(page: import('@playwright/test').Page): Promise<string> {
  const health = await (await fetch(`${backend}/health`)).json() as { account: string };
  await page.addInitScript(({ simulationRun }) => {
    localStorage.setItem('cb_current_city', 'san_francisco');
    localStorage.setItem('cb_site_intro_seen_v1', '1');
    localStorage.setItem('bets-simulation-run-v1', simulationRun);
  }, { simulationRun: run });
  await page.goto(`/?city=san_francisco&reduceMotion=1&betTest=${run}&backend=${encodeURIComponent(backend)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as any).map && !!(window as any).BetsTrading);
  return health.account;
}

test('points buy, sell, reload, simulated resolution and claim use the real local ledger', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openPointsPreview(page);
  await page.locator('#bets-button').click();
  const row = page.locator('#bets-sheet .bets-row').first();
  await expect(row).toContainText(/points preview agreement/i);
  await row.locator('.btn-market-yes').click();
  let dialog = page.locator('#proposalMarketOverlay');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Max 1000 points');
  const buyChip = dialog.locator('.bets-dialog__chip').filter({ hasText: /^100$/ });
  await buyChip.click();
  const buyQuote = dialog.locator('[data-market-towin]');
  await expect(buyQuote).toBeVisible();
  const quoteText = await buyQuote.innerText();
  await dialog.locator('[data-market-submit]').click();
  await expect(dialog.locator('[data-market-dialog-status]')).toContainText(/placed|bought|confirmed/i);
  await expect(dialog).toContainText(/Available:/);
  const balanceAfterBuy = BigInt(await page.evaluate(async () => (await (window as any).BetsTrading.readAccount()).balance));
  expect(balanceAfterBuy).toBeLessThan(1_000_000_000n);
  await dialog.getByRole('button', {name:/your position/i}).click();
  await expect(dialog.locator('.bets-dialog__collect').getByRole('button', {name:/sell yes shares/i})).toBeVisible();
  await dialog.locator('.bets-dialog__collect').getByRole('button', {name:/sell yes shares/i}).click();
  const sellAmount = dialog.locator('[data-market-amount]');
  await sellAmount.fill('50');
  const sellQuote = await dialog.locator('[data-market-towin]').innerText();
  await dialog.locator('[data-market-submit]').click();
  await expect(dialog.locator('[data-market-dialog-status]')).toContainText(/confirmed/i);
  const balanceAfterSell = BigInt(await page.evaluate(async () => (await (window as any).BetsTrading.readAccount()).balance));
  expect(balanceAfterSell).toBeGreaterThan(balanceAfterBuy);
  expect(sellQuote).toMatch(/Sell/);
  await dialog.locator('[data-market-done]').click();
  // Buy a fresh YES position so the later simulated execution has something claimable.
  await dialog.locator('.bets-dialog__footer .btn-market-yes').click().catch(async () => {
    await page.locator('#bets-sheet .bets-row').first().locator('.btn-market-yes').click();
  });
  await dialog.locator('.bets-dialog__chip').filter({ hasText: /^100$/ }).click();
  await dialog.locator('[data-market-submit]').click();
  await expect(dialog.locator('[data-market-dialog-status]')).toContainText(/confirmed/i);
  await page.reload();
  dialog = page.locator('#proposalMarketOverlay');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/Your bets:/);
  await fetch(`${backend}/__simulation/state`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({chainStatus:'executed',executedAt:Math.floor(Date.now()/1000)-1}) });
  await dialog.locator('.close-circle-btn').click();
  await page.evaluate(async () => { await (window as any).BetsSheet.load({force:true,fresh:true}); });
  await page.locator('#bets-button').click();
  await row.locator('.bets-row__title').click();
  dialog = page.locator('#proposalMarketOverlay');
  await expect(dialog.locator('.bets-dialog__footer').getByRole('button', {name:/settle market/i})).toBeVisible();
  await dialog.locator('.bets-dialog__footer').getByRole('button', {name:/settle market/i}).click();
  await expect(dialog.locator('[data-market-dialog-status]')).toContainText(/settled/i);
  const collect = dialog.locator('.bets-dialog__collect .btn');
  await expect(collect).toBeVisible();
  await collect.click();
  await expect(dialog.locator('[data-market-dialog-status]')).toContainText(/collected/i);
  expect(quoteText).toMatch(/Buy|buy/);
  expect(errors).toEqual([]);
});

test('reconciles a committed buy when its HTTP response is lost without a second debit', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openPointsPreview(page);
  await page.locator('#bets-button').click();
  const row = page.locator('#bets-sheet .bets-row').first();
  await expect(row).toContainText(/points preview agreement/i);
  const armed = await fetch(`${backend}/__simulation/lose-next-trade-response`, { method:'POST' });
  expect(armed.ok).toBe(true);
  await row.locator('.btn-market-yes').click();
  const dialog = page.locator('#proposalMarketOverlay');
  await dialog.locator('.bets-dialog__chip').filter({ hasText: /^100$/ }).click();
  await dialog.locator('[data-market-submit]').click();
  await expect(dialog.locator('[data-market-dialog-status]')).toContainText(/needs confirmation|pending receipt|confirmation/i);
  await page.reload();
  const restored = page.locator('#proposalMarketOverlay');
  await expect(restored).toBeVisible();
  const pending = await page.evaluate(async () => (window as any).BetsTrading.pending());
  expect(pending?.path).toBe('trade');
  expect(pending?.data?.requestId).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(restored.getByRole('button', {name:/check pending receipt/i})).toBeVisible();
  const before = await page.evaluate(async () => String((await (window as any).BetsTrading.readAccount()).balance));
  let retryRequestId: string | undefined;
  page.on('request', request => {
    if (request.url().endsWith('/bets/points/trade') && request.method() === 'POST') {
      try { retryRequestId = request.postDataJSON().requestId; } catch { /* ignore non-JSON requests */ }
    }
  });
  await restored.getByRole('button', {name:/check pending receipt/i}).click();
  await expect(restored.locator('.bets-account__balance')).toContainText(/confirmed/i);
  const receipt = await page.evaluate(async () => (window as any).BetsTrading.pending());
  expect(receipt).toBeNull();
  expect(retryRequestId).toBe(pending.data.requestId);
  const after = await page.evaluate(async () => String((await (window as any).BetsTrading.readAccount()).balance));
  expect(after).toBe(before);
  expect(errors).toEqual([]);
});
