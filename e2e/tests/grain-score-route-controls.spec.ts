// Exercise drawing and route controls and verify the resulting scores and geometry.
import { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { createSpace, openCity, showProposal, chooseTermsForShare } from '../helpers/runtime';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';
import { attachSharedProposalServer, createSharedProposalServer } from '../helpers/mocks/shared-server';

async function newPlanReceiver(
  browser: Browser,
  baseURL: string | undefined,
  url: string,
  server: ReturnType<typeof createSharedProposalServer>,
  plan: Record<string, any>,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('cb_current_city', 'zagreb');
      localStorage.setItem('cb_site_intro_seen_v1', '1');
    } catch { /* opaque origin */ }
  });
  const page = await context.newPage();
  await mockAllApiRoutes(page);
  await attachSharedProposalServer(page, server);
  await page.route('**/plans/grain-score-route-test', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(plan) });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  return { context, page };
}

async function personalize(page: Page): Promise<void> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Grain score route tester');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
}

test('named-plan grain-score route prepares the real plan and Start runs its inspection @features', async ({ browser, baseURL, mockApi: authorPage }) => {
  const server = createSharedProposalServer();
  await attachSharedProposalServer(authorPage, server);
  await openCity(authorPage);
  await personalize(authorPage);
  const drawingId = await createSpace(authorPage, 'park');
  await showProposal(authorPage, drawingId);
  await authorPage.locator('.btn-share-proposal').click();
  const localId = await chooseTermsForShare(authorPage);
  const proposal = await authorPage.evaluate(id => JSON.parse(JSON.stringify((window as any).proposalStorage.getProposal(id))), localId);
  const share = authorPage.locator('.share-modal-overlay');
  await share.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(share.locator('.share-modal-link').first()).toHaveValue(/\/proposals\/\d+\?/);

  const serverId = String([...server.records.keys()][0]);
  expect(serverId).toBeTruthy();
  const slug = 'grain-score-route-test';
  const plan = {
    slug,
    title: 'Grain score route plan',
    city: proposal.city || 'zagreb',
    proposalRowIds: [serverId],
  };
  const receiver = await newPlanReceiver(browser, baseURL, `/plans/${slug}/score?city=zg`, server, plan);
  try {
    const panel = receiver.page.locator('#grain-score-panel');
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(panel.locator('[data-grain-role="ready"]')).toBeVisible({ timeout: 60_000 });
    await expect(panel.locator('[data-grain-role="planName"]')).toContainText(plan.title);
    const start = panel.locator('[data-grain-action="start"]');
    await expect(start).toBeVisible();
    await start.click();
    await expect(panel.locator('[data-grain-role="result"]')).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('[data-grain-role="totalScore"]')).toHaveText(/^\d+$/);
  } finally {
    await receiver.context.close();
  }
});
