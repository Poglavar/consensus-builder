import { test, expect } from '../helpers/fixtures';
import type { Page } from '@playwright/test';
import { openCity, stubBasemapTiles, PARCEL_ID } from '../helpers/runtime';

async function openDesignList(page: Page): Promise<void> {
  await stubBasemapTiles(page);
  await openCity(page);
  await page.evaluate(parcelId => {
    const storage = (window as any).proposalStorage;
    for (let index = 0; index < 15; index++) {
      storage.addProposal({
        proposalId: `e2e-design-layout-${index}`,
        title: `Neighbourhood design layout ${index} with a distinguishable suffix`,
        author: 'Neighbourhood layout fixture author',
        goal: 'park',
        lifecycleStatus: 'Active',
        applied: true,
        cadastreParcelIds: [parcelId],
      });
    }
  }, PARCEL_ID);
  await page.locator('#proposals-button').click();
  const sheet = page.locator('#proposals-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Urban rooster', exact: true })).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Plan stats', exact: true })).toHaveCount(0);
  await sheet.locator('.lists-filter-toggle').click();
  await expect(sheet.locator('[data-list-filter="publication"]')).toBeVisible();
  await sheet.locator('.lists-filter-toggle').click();
}

async function assertCardsStayAligned(page: Page, viewportWidth: number): Promise<void> {
  const rows = page.locator('#proposal-list-host .lists-item');
  await expect(rows).toHaveCount(15);
  for (const row of [rows.first(), rows.last()]) {
    await row.scrollIntoViewIfNeeded();
    expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(row.locator('.lists-item__title')).toBeInViewport();
    await expect(row.locator('.fa-tree')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Share', exact: true })).toBeInViewport();
    await expect(row.getByRole('button', { name: 'Remove from browser', exact: true })).toBeInViewport();
    const box = await row.boundingBox();
    expect(box!.x).toBeGreaterThan(0);
    expect(box!.x + box!.width).toBeLessThan(viewportWidth);
  }
}

test.describe('design list card layout @features', () => {
  test('desktop list fills the space between map chrome and keeps row controls aligned', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDesignList(page);
    const sheet = page.locator('#proposals-sheet');
    const sheetBox = await sheet.boundingBox();
    // Lists shares the right-dock column with the click stack (docs/click-stack.md): it starts a
    // small gap below the top chrome and ends where the dock clears the visible bottom controls.
    const clearances = await page.evaluate(() => {
      const probe = document.createElement('div');
      Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', width: '0', top: '0' });
      document.body.append(probe);
      probe.style.height = 'calc(var(--map-shell-top-clearance) + var(--cb-space-2))';
      const top = probe.getBoundingClientRect().height;
      probe.style.height = 'var(--right-dock-bottom)';
      const bottom = probe.getBoundingClientRect().height;
      probe.remove();
      return { top, bottom };
    });
    expect(sheetBox).not.toBeNull();
    expect(Math.abs(sheetBox!.y - clearances.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(900 - sheetBox!.y - sheetBox!.height - clearances.bottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(sheetBox!.height - (900 - clearances.top - clearances.bottom))).toBeLessThanOrEqual(1);
    await assertCardsStayAligned(page, 1280);
  });

  test('phone list keeps row controls aligned and first and last Details reachable while scrolling', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDesignList(page);
    await assertCardsStayAligned(page, 390);
  });
});
