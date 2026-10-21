import { test, expect } from '../helpers/fixtures';
import { openCity, drawCorridor, showProposal } from '../helpers/runtime';
import { pageIndex } from '../helpers/mocks/shared-server';

test('a published track opens the configured cab simulator with its design CID', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openCity(page);
  await page.locator('#username-display').click();
  await page.locator('#username-input').fill('Track author');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
  const id = await drawCorridor(page, 'track');
  await showProposal(page, id);
  const details = page.locator('#proposal-details-panel');
  // The sim reads designs from the index by CID, so an unpublished track has no Drive.
  await expect(details.locator('.btn-drive-proposal')).toHaveCount(0);
  await details.locator('.btn-share-proposal').click();
  const index = pageIndex(page);
  await expect.poll(() => index.designs.size, { timeout: 30_000 }).toBe(1);
  const [cid] = [...index.designs.keys()];
  await expect.poll(() => page.evaluate(id => {
    const w = window as any;
    return w.DesignSync.publishedCid(w.proposalStorage.getProposal(id));
  }, id)).toBe(cid);
  await showProposal(page, id);
  await expect.poll(() => page.evaluate(() => (window as any).ProposalSelection.getKey())).toBe(id);
  await expect(details).toBeVisible();
  const base = await page.evaluate(() => (window as any).CityConfigManager.getDriveConfig().url);
  await page.context().route(`${base}**`, route => route.fulfill({ contentType: 'text/html', body: '<title>Cab simulator fixture</title>' }));
  const opened = page.context().waitForEvent('page');
  await details.locator('.btn-drive-proposal').click();
  const child = await opened;
  await child.waitForURL(url => url.href.startsWith(base));
  const url = new URL(child.url());
  expect(url.searchParams.get('st3d')).toBe('cab');
  expect(url.searchParams.get('track')).toBe(cid);
  expect(url.searchParams.get('proposals')?.split(',')).toContain(cid);
  await child.close();
});
