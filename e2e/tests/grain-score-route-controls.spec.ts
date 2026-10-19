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

for (const scenario of ['titled', 'untitled', 'fork']) {
const title = scenario === 'untitled' ? '' : 'Grain score route plan';
test(`named-plan grain-score route ${scenario} verifies its published membership @features`, async ({ browser, baseURL, mockApi: authorPage }) => {
  // Two browser contexts publish, load and inspect; keep the overall cap above the per-phase waits.
  test.setTimeout(90_000);
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
    title,
    city: proposal.city || 'zagreb',
    proposalRowIds: [serverId],
    members: [{ proposalRowId: serverId, authoredProposalId: server.records.get(serverId)!.proposalId, changed: false }],
  };
  const receiver = await newPlanReceiver(browser, baseURL, `/plans/${slug}/score?city=zg`, server, plan);
  try {
    const panel = receiver.page.locator('#grain-score-panel');
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(panel.locator('[data-grain-role="ready"]')).toBeVisible({ timeout: 60_000 });
    await expect(panel.locator('[data-grain-role="planName"]')).toHaveText(title || slug);
    await expect(panel.locator('[data-grain-role="route"]')).toHaveText(`Named plan · /plans/${slug}/score`);

    if (scenario === 'fork') {
      await panel.locator('[data-grain-action="close"]').click();
      const forkId = await receiver.page.evaluate(async rowId => {
        const w = window as any;
        const source = w.proposalStorage.getAllProposals().find((p: any) => String(p.serverProposalId) === rowId);
        await w.ProposalManager.unapplyProposal(source.proposalId);
        const draft = w.proposalDraftStore.createDraftFromProposal(source, { activate: true, forceNew: true });
        return w.instantCreateProposalFromDraft(draft.id);
      }, serverId);
      expect(forkId).toBeTruthy();
      expect(forkId).not.toBe(plan.members[0].authoredProposalId);
      const fork = await receiver.page.evaluate(id => (window as any).proposalStorage.getProposal(id), forkId);
      expect(fork.sourceProposalId).toBe(plan.members[0].authoredProposalId);
      expect(fork.serverProposalId).toBeFalsy();
      const appliedIds = () => receiver.page.evaluate(() => {
        const w = window as any;
        return w.proposalStorage.getAllProposals().filter((p: any) => w.isProposalCurrentlyApplied(p)).map((p: any) => p.proposalId);
      });
      expect(await appliedIds()).toEqual([forkId]);
      // Re-enter from the score action. It must fetch current verification and reject the fork
      // even though the shared loader considers its original already represented on the map.
      await Promise.all([
        receiver.page.waitForRequest(request => request.method() === 'GET' && request.url().endsWith(`/plans/${slug}`)),
        receiver.page.evaluate(() => (window as any).summonUrbanistRooster()),
      ]);
      await expect(panel.locator('[data-grain-role="error"]')).toContainText('A local edit or fork cannot replace a member.');
      await expect(panel.locator('[data-grain-action="start"]')).toBeHidden();
      await expect(panel.locator('[data-grain-role="result"]')).toBeHidden();
      expect(await appliedIds()).toEqual([forkId]);
      return;
    }
    const start = panel.locator('[data-grain-action="start"]');
    await expect(start).toBeVisible();
    await start.click();
    await expect(panel.locator('[data-grain-role="result"]')).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('[data-grain-role="totalScore"]')).toHaveText(/^\d+$/);
  } finally {
    await receiver.context.close();
  }
});
}
