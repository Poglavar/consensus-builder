// Exercise site authoring and verify both dismiss controls discard only the temporary site.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, clickMapPoint, runParcelCommand } from '../helpers/runtime';

test.describe('Site authoring @features', () => {
  test('a parcel becomes an editable site; redraw, undo, finish and build persist its authored geometry', async ({ mockApi: page }) => {
    await openCity(page);
    await runParcelCommand(page, 15.9822, 45.80025, 'parcel.useAsSite');
    await expect(page.locator('#site-panel')).toBeVisible();
    await expect(page.locator('.site-panel__area')).toContainText('m²');
    await page.locator('[data-site-action="redraw"]').click();
    await clickMapPoint(page, 15.9820, 45.8001);
    await clickMapPoint(page, 15.9824, 45.8001);
    await clickMapPoint(page, 15.9824, 45.8004);
    const ring = () => page.evaluate(() => (window as any).SiteTool.current().ring.length);
    await expect.poll(ring).toBe(3);
    await page.locator('[data-site-action="undo"]').click();
    await expect.poll(ring).toBe(2);
    await expect(page.locator('[data-site-action="finish"]')).toBeDisabled();
    await clickMapPoint(page, 15.9824, 45.8004);
    await clickMapPoint(page, 15.9820, 45.8004);
    await page.locator('[data-site-action="finish"]').click();
    const authoredSite = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).SiteTool.current().site)));
    await page.locator('[data-site-action="propose"]').click();
    await page.locator('#site-info-panel .parcel-build-btn--park').click();
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p: any) => p.applied && p.structureProposal?.kind === 'park'))).toBe(true);
    const site = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.structureProposal?.kind === 'park').site);
    expect(site.type).toMatch(/Polygon/);
    expect(site).toEqual(authoredSite);
    expect(await page.evaluate((geometry) => (window as any).turf.area(geometry), site)).toBeLessThan(1800);
    expect(await page.evaluate(() => (window as any).SiteTool.isActive())).toBe(false);
  });

  for (const close of ['.site-panel__close', '.site-panel__actions [data-site-action="cancel"]']) test(`site ${close} discards temporary geometry without creating a proposal`, async ({ mockApi: page }) => {
    await openCity(page);
    await runParcelCommand(page, 15.9822, 45.80025, 'parcel.useAsSite');
    await page.locator(`#site-panel ${close}`).click();
    await expect(page.locator('#site-panel')).toBeHidden();
    expect(await page.evaluate(() => (window as any).SiteTool.isActive())).toBe(false);
    expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(0);
    await openParcel(page);
    await expect(page.locator('#parcel-info-panel')).toBeVisible();
  });
});
