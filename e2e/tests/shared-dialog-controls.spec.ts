// Check real shared-proposal review and partial import-result actions across separate browsers.
import { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { createSpace, openCity, proposalState, showProposal, PARCEL_GEOMETRY, PARCEL_ID } from '../helpers/runtime';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';
import { attachSharedProposalServer, createSharedProposalServer } from '../helpers/mocks/shared-server';

function sharedUrl(payload: Record<string, any>): string {
  return `/?city=zg&shared=u.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

async function newReceiver(
  browser: Browser,
  baseURL: string | undefined,
  url: string,
  server?: ReturnType<typeof createSharedProposalServer>,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.addInitScript(() => {
    try {
      localStorage.setItem('cb_current_city', 'new_york');
      localStorage.setItem('cb_site_intro_seen_v1', '1');
    } catch { /* opaque origin */ }
  });
  const page = await context.newPage();
  await mockAllApiRoutes(page);
  if (server) await attachSharedProposalServer(page, server);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  return { context, page };
}

function payload(proposals: Record<string, any>[]) {
  return { version: 1, author: 'Shared dialog control test', generatedAt: new Date().toISOString(), proposals };
}

async function personalize(page: Page): Promise<void> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Shared dialog tester');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
}

test.describe('shared dialog button controls @features', () => {
  test('shared payload inspector Cancel dismisses without importing', async ({ browser, baseURL }) => {
    const proposal = { proposalId: 'shared-inspector-cancel', title: 'Inspector cancel target', goal: 'park' };
    const receiver = await newReceiver(browser, baseURL, sharedUrl(payload([proposal])));
    try {
      const modal = receiver.page.locator('.share-modal-overlay');
      await expect(modal).toContainText(/Review shared proposals/i);
      await expect(modal.locator('.shared-payload-inspector .spi-proposal-item')).toContainText(proposal.title);
      await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(modal).toBeHidden();
      expect(await receiver.page.evaluate(id => !!(window as any).proposalStorage.getProposal(id), proposal.proposalId)).toBe(false);
    } finally {
      await receiver.context.close();
    }
  });

  test('shared payload inspector Apply Selected applies the selected proposal and Unapply applied removes it', async ({ browser, baseURL, mockApi: authorPage }) => {
    await openCity(authorPage);
    await personalize(authorPage);
    const sourceId = await createSpace(authorPage, 'park');
    const proposal = await authorPage.evaluate(({ id, geometry }) => {
      const source = JSON.parse(JSON.stringify((window as any).proposalStorage.getProposal(id)));
      // A live Park proposal supplies the full valid schema, but its sampled decorations include
      // high-resolution paths. Keep the same proposal and parcel binding while using its simple
      // parcel polygon in each geometry slot so the share-link remains a practical URL.
      source.site = { type: 'MultiPolygon', coordinates: [geometry.coordinates] };
      source.geometry = geometry;
      if (source.structureProposal) {
        source.structureProposal.geometry = geometry;
        source.structureProposal.decorations = { ponds: [], paths: [], trees: [], version: 2 };
      }
      return source;
    }, { id: sourceId, geometry: PARCEL_GEOMETRY });
    const unselected = JSON.parse(JSON.stringify(proposal));
    unselected.proposalId = `${sourceId}-unselected`;
    unselected.title = 'Park left unselected';
    const insetGeometry = {
      type: 'Polygon',
      coordinates: [[
        [15.9820, 45.8001], [15.9823, 45.8001], [15.9823, 45.8004],
        [15.9820, 45.8004], [15.9820, 45.8001],
      ]],
    };
    unselected.geometry = insetGeometry;
    if (unselected.structureProposal) unselected.structureProposal.geometry = insetGeometry;
    const receiver = await newReceiver(browser, baseURL, sharedUrl(payload([proposal, unselected])));
    try {
      const modal = receiver.page.locator('.share-modal-overlay');
      await expect(modal).toContainText(/Review shared proposals/i);
      const items = modal.locator('.shared-payload-inspector .spi-proposal-item');
      await expect(items).toHaveCount(2);
      const secondCheckbox = items.nth(1).locator('input[type="checkbox"]');
      await expect(secondCheckbox).toBeChecked();
      await secondCheckbox.uncheck();
      await expect(secondCheckbox).not.toBeChecked();
      const apply = modal.getByRole('button', { name: /^Apply selected$/i });
      await expect(apply).toBeEnabled({ timeout: 30_000 });
      await apply.click();
      await expect.poll(async () => (await proposalState(receiver.page, sourceId))?.applied, { timeout: 60_000 }).toBe(true);
      expect(await receiver.page.evaluate(id => !!(window as any).proposalStorage.getProposal(id), unselected.proposalId)).toBe(false);
      const summary = receiver.page.locator('.share-modal-overlay').filter({ hasText: 'Applied shared proposals' });
      await expect(summary).toContainText('1 applied.');
      await summary.getByRole('button', { name: 'Unapply applied', exact: true }).click();
      await expect.poll(async () => (await proposalState(receiver.page, sourceId))?.applied).toBe(false);
      await expect(summary).toBeHidden();
    } finally {
      await receiver.context.close();
    }
  });

  test('partial shared plan result supports Copy and Close', async ({ browser, baseURL, mockApi: authorPage }) => {
    const server = createSharedProposalServer();
    await attachSharedProposalServer(authorPage, server);
    await openCity(authorPage);
    await personalize(authorPage);
    const localId = await createSpace(authorPage, 'park');
    await showProposal(authorPage, localId);
    await authorPage.locator('.btn-share-proposal').click();
    const shareModal = authorPage.locator('.share-modal-overlay');
    await shareModal.getByRole('button', { name: 'Download', exact: true }).click();
    await shareModal.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(shareModal.locator('.share-modal-link').first()).toHaveValue(/\/proposals\/\d+\?/);
    const serverId = String([...server.records.keys()][0]);
    expect(serverId).toBeTruthy();

    const receiver = await newReceiver(browser, baseURL, `/proposals/${serverId},7999?city=zg`, server);
    try {
      const result = receiver.page.locator('.share-modal-overlay');
      await expect(result).toContainText(/Shared plan result/i, { timeout: 60_000 });
      const copy = result.getByRole('button', { name: 'Copy', exact: true });
      await copy.click();
      await expect(result).toBeVisible();
      await expect.poll(() => receiver.page.evaluate(() => navigator.clipboard.readText()))
        .toMatch(/Shared plan result/i);
      await expect(result).toContainText('Applied 1 proposal');
      await expect(result).toContainText('Not found on server');
      await result.locator('.share-modal .btn-primary').click();
      await expect(result).toBeHidden();
      await expect.poll(async () => (await proposalState(receiver.page, String(server.records.get(serverId)?.proposalId)))?.applied, { timeout: 60_000 }).toBe(true);
    } finally {
      await receiver.context.close();
    }
  });
});
