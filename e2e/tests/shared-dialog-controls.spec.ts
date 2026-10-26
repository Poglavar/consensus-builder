// Check the shared-design result dialog of a partly missing /designs/<cid>,<cid> link across separate browsers.
import { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { createSpace, openCity, showProposal, confirmDesignOnlyShare } from '../helpers/runtime';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';
import { attachSharedIndex, cidOfObject, pageIndex, SharedIndex } from '../helpers/mocks/shared-server';

async function newReceiver(
  browser: Browser,
  baseURL: string | undefined,
  url: string,
  index: SharedIndex,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('cb_current_city', 'new_york');
      localStorage.setItem('cb_site_intro_seen_v1', '1');
    } catch { /* opaque origin */ }
  });
  const page = await context.newPage();
  await mockAllApiRoutes(page);
  await attachSharedIndex(page, index);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  return { context, page };
}

async function personalize(page: Page): Promise<void> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Shared dialog tester');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
}

test.describe('shared dialog button controls @features', () => {
  test('a partly missing design link applies the design it finds, and its result dialog lists the missing one and closes', async ({ browser, baseURL, mockApi: authorPage }) => {
    // Two devices: the author publishes a park through Share, the receiver opens it with a CID the index never held.
    test.setTimeout(150_000);
    await openCity(authorPage);
    await personalize(authorPage);
    const localId = await createSpace(authorPage, 'park');
    await showProposal(authorPage, localId);
    await authorPage.locator('#proposal-details-panel .btn-share-proposal').click();
    await confirmDesignOnlyShare(authorPage);
    const index = pageIndex(authorPage);
    await expect.poll(() => index.designs.size, { timeout: 30_000 }).toBe(1);
    const [cid] = [...index.designs.keys()];
    const missing = cidOfObject({ schema: 'design/v1', title: 'Never published' });

    const receiver = await newReceiver(browser, baseURL, `/designs/${cid},${missing}?city=zg&reduceMotion=1`, index);
    try {
      const result = receiver.page.locator('.share-modal-overlay').filter({ has: receiver.page.locator('.shared-plan-failures') });
      await expect(result).toBeVisible({ timeout: 90_000 });
      await expect(result).toContainText('Shared designs');
      await expect(result).toContainText('1 of the shared designs could not be opened:');
      await expect(result.locator('.shared-plan-failures li')).toHaveText([`${missing} · This design is not on the server.`]);
      // The design the index holds was imported under its CID and applied all the same.
      await expect.poll(() => receiver.page.evaluate(id => {
        const w = window as any;
        const record = w.proposalStorage.getProposal(id);
        return !!record && !!w.isApplied(record);
      }, `design-${cid}`), { timeout: 60_000 }).toBe(true);
      expect(await receiver.page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(1);
      await result.locator('.cb-dialog__footer').getByRole('button', { name: 'Close', exact: true }).click();
      await expect(result).toBeHidden();
    } finally {
      await receiver.context.close();
    }
  });
});
