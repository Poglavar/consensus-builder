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
        epochYear: 2035,
        cadastreParcelIds: [parcelId],
      });
    }
  }, PARCEL_ID);
  await page.locator('#proposals-button').click();
  const sheet = page.locator('#proposals-sheet');
  await expect(sheet).toBeVisible();
  await expect(page.locator('#roosterScoreButton')).toHaveAccessibleName('Urban rooster');
  await expect(page.locator('#roosterScoreButton strong')).toHaveText('Urban rooster');
  await expect(sheet.locator('#agreementsButton, #mintedAgreementsButton')).toHaveCount(0);
  await sheet.locator('.proposal-filters-toggle').click();
  await expect(sheet.locator('#proposal-filter-applied, #proposal-filter-author')).toHaveCount(0);
  await expect(sheet.locator('.proposal-filters-toggle-count')).toHaveCount(0);
  await sheet.locator('.proposal-filters-toggle').click();
}

async function assertCardsStayAligned(page: Page, viewportWidth: number): Promise<void> {
  const rows = page.locator('#proposals-sheet .proposal-list-item');
  await expect(rows).toHaveCount(15);
  const row = rows.first();
  expect(await row.evaluate(element => Array.from(element.children, child => (child as HTMLElement).className))).toEqual([
    'proposal-card-head', 'proposal-card-sub', 'proposal-card-actions',
  ]);
  const rowFits = await row.evaluate(element => element.scrollWidth <= element.clientWidth);
  expect(rowFits).toBe(true);
  const title = row.locator('.proposal-card-head .proposal-list-title');
  const headButton = row.locator('.proposal-card-head button');
  const [titleBox, headButtonBox] = await Promise.all([title.boundingBox(), headButton.boundingBox()]);
  expect(titleBox).not.toBeNull();
  expect(headButtonBox).not.toBeNull();
  expect(Math.abs((titleBox!.y + titleBox!.height / 2) - (headButtonBox!.y + headButtonBox!.height / 2))).toBeLessThanOrEqual(2);
  const meta = row.locator('.proposal-card-sub');
  const metaBox = await meta.boundingBox();
  const metaSpanBoxes = await meta.locator('span').evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    return { y: box.y, height: box.height };
  }));
  expect(metaBox).not.toBeNull();
  expect(metaSpanBoxes.length).toBeGreaterThan(0);
  for (const box of metaSpanBoxes) {
    expect(Math.abs((metaBox!.y + metaBox!.height / 2) - (box.y + box.height / 2))).toBeLessThanOrEqual(2);
  }
  const actions = row.locator('.proposal-card-actions');
  const details = actions.locator('.proposal-list-details-btn');
  const badge = actions.locator('.proposal-card-badges');
  const epoch = actions.locator('.proposal-epoch-card-select');
  await expect(details).toBeVisible();
  await expect(epoch).toHaveValue('2035');
  await expect(badge).toContainText(/Applied/);

  const [detailsBox, badgeBox, epochBox] = await Promise.all([
    details.boundingBox(), badge.boundingBox(), epoch.boundingBox(),
  ]);
  expect(detailsBox).not.toBeNull();
  expect(badgeBox).not.toBeNull();
  expect(epochBox).not.toBeNull();
  const detailsCenterY = detailsBox!.y + detailsBox!.height / 2;
  const badgeCenterY = badgeBox!.y + badgeBox!.height / 2;
  const epochCenterY = epochBox!.y + epochBox!.height / 2;
  expect(Math.abs(detailsCenterY - badgeCenterY)).toBeLessThanOrEqual(2);
  expect(Math.abs(detailsCenterY - epochCenterY)).toBeLessThanOrEqual(2);
  expect(epochBox!.x).toBeGreaterThan(detailsBox!.x);
  expect(epochBox!.width).toBeLessThanOrEqual(viewportWidth === 390 ? 100 : 85);
  expect(await epoch.evaluate(element => element.parentElement?.lastElementChild === element)).toBe(true);

  const listBody = page.locator('#proposals-sheet .proposal-list-modal-body');
  await listBody.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(rows.last().locator('.proposal-epoch-card-select')).toHaveValue('2035');
  await expect(rows.last().locator('.proposal-list-details-btn')).toBeInViewport({ ratio: 1 });
  await rows.first().locator('.proposal-list-details-btn').scrollIntoViewIfNeeded();
  await expect(rows.first().locator('.proposal-list-details-btn')).toBeInViewport({ ratio: 1 });
  await expect(rows.first().locator('.proposal-epoch-card-select')).toHaveValue('2035');
}

test.describe('design list card layout @features', () => {
  test('desktop list fills the space between map chrome and keeps row controls aligned', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDesignList(page);
    const sheet = page.locator('#proposals-sheet');
    const sheetBox = await sheet.boundingBox();
    const clearances = await page.evaluate(() => {
      const probe = document.createElement('div');
      Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', width: '0', top: '0' });
      document.body.append(probe);
      probe.style.height = 'var(--map-shell-top-clearance)';
      const top = probe.getBoundingClientRect().height;
      probe.style.height = 'var(--map-shell-bottom-clearance)';
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
