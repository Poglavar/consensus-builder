// Naming a selected composition produces a durable compact link; another device restores that snapshot.
import { test, expect } from '../helpers/fixtures';
import { createSpace, openCity, stubBasemapTiles, openOnAnotherDevice } from '../helpers/runtime';
import { fileDesign, pageIndex } from '../helpers/mocks/shared-server';

test.setTimeout(120_000);
for (const width of [1280, 390]) {
  test(`name a plan, revise its name, and open the original snapshot at ${width}px`, async ({ mockApi: page, browser, baseURL }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await stubBasemapTiles(page);
    await openCity(page);
    const id = await createSpace(page, 'park');
    const content = await page.evaluate(id => (window as any).DesignRecord.published((window as any).proposalStorage.getProposal(id)), id);
    const index = pageIndex(page);
    const designCid = fileDesign(index, content);
    await page.evaluate(({ id, cid }) => {
      const w = window as any;
      w.DesignSync.markPublished(w.proposalStorage.getProposal(id), { cid, apiBase: w.resolveBackendBaseUrl(), publishedAt: '2026-10-24T12:00:00Z' });
      w.PlanningViews.configure('existing', 'ghost');
    }, { id, cid: designCid });
    await page.locator('#proposals-button').click();
    await page.locator('#shareAppliedProposalsButton').click();
    await page.getByRole('button', { name: 'Name this plan', exact: true }).click();
    await page.getByLabel('Plan name', { exact: true }).fill('Riverside Garden');
    await page.getByRole('button', { name: 'Save plan link', exact: true }).click();
    const linkInput = page.locator('.share-plan-link__input[readonly]');
    await expect(linkInput).toHaveValue(/\/plans\/bafkrei[a-z2-7]{52}$/);
    const originalLink = await linkInput.inputValue();
    const originalCid = new URL(originalLink).pathname.split('/').pop()!;
    const original = index.plans.get(originalCid)!;
    expect(original.content).toMatchObject({ title: 'Riverside Garden', designCids: [designCid], view: { city: 'zagreb', mode: '2d', settings: { existing: 'ghost' } } });
    expect(index.agreements.size).toBe(0);
    await expect(page.locator('.share-plan-saved-name')).toHaveText('Riverside Garden');
    await expect(page.getByRole('button', { name: 'Copy URL', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`named-plan-${width}.png`) });

    // Deselecting the only member must remove the old named link.
    await page.locator('.share-plan-row input[type=checkbox]').uncheck();
    await expect(page.locator('.share-plan-link')).toBeHidden();
    await expect(page.locator('.share-plan-save-name')).toBeDisabled();
    await page.locator('.share-plan-row input[type=checkbox]').check();
    await page.getByRole('button', { name: 'Rename plan', exact: true }).click();
    await page.getByLabel('Plan name', { exact: true }).fill('Riverside Garden revised');
    await expect(linkInput).not.toHaveValue(originalLink);
    await page.getByRole('button', { name: 'Save plan link', exact: true }).click();
    await expect(linkInput).toHaveValue(/\/plans\/bafkrei[a-z2-7]{52}$/);
    expect(await linkInput.inputValue()).not.toBe(originalLink);
    expect(index.plans.get(originalCid)).toEqual(original);

    const receiver = await openOnAnotherDevice(browser, originalLink, index, baseURL);
    try {
      await expect.poll(() => receiver.page.evaluate(cid => {
        const w = window as any;
        const record = w.DesignSync?.localCopyOf(cid);
        return !!record && w.isApplied(record);
      }, designCid).catch(() => false), { timeout: 60000 }).toBe(true);
      await expect(receiver.page).toHaveTitle('Riverside Garden · Consensus Builder');
      const actual = await receiver.page.evaluate(() => {
        const w = window as any;
        return { city: w.CityConfigManager.getCurrentCityId(), at: [w.map.getCenter().lat, w.map.getCenter().lng, w.map.getZoom()], existing: w.PlanningViews.getState().existing };
      });
      expect(actual.city).toBe('zagreb');
      expect(actual.existing).toBe('ghost');
      const at = original.content.view.at.split(',').map(Number);
      expect(actual.at[0]).toBeCloseTo(at[0], 4); expect(actual.at[1]).toBeCloseTo(at[1], 4); expect(actual.at[2]).toBe(at[2]);
      expect(new URL(receiver.page.url()).pathname).toBe(`/plans/${originalCid}`);
      await expect(receiver.page.locator('#agreement-editor-title')).not.toBeVisible();
    } finally { await receiver.context.close(); }
  });
}

test('save errors are visible and leave the ordinary design link available for retry', async ({ mockApi: page }) => {
  await stubBasemapTiles(page); await openCity(page);
  const id = await createSpace(page, 'park');
  await page.evaluate(id => { const w = window as any; const record = w.proposalStorage.getProposal(id);
    w.DesignSync.markPublished(record, { cid: w.DesignRecord.cidOf(record), apiBase: w.resolveBackendBaseUrl() }); }, id);
  await page.route('**/plans', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Storage is unavailable' }) }));
  await page.locator('#proposals-button').click(); await page.locator('#shareAppliedProposalsButton').click();
  await page.getByRole('button', { name: 'Name this plan', exact: true }).click();
  await page.getByLabel('Plan name', { exact: true }).fill('Garden');
  await page.getByRole('button', { name: 'Save plan link', exact: true }).click();
  await expect(page.locator('.share-plan-status')).toContainText('Storage is unavailable');
  await expect(page.getByRole('button', { name: 'Save plan link', exact: true })).toBeEnabled();
  await expect(page.locator('.share-plan-link__input[readonly]')).toHaveValue(/\/designs\//);
});
