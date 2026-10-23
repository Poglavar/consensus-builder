import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, chooseProfileName, stubBasemapTiles } from '../helpers/runtime';
import { pageIndex } from '../helpers/mocks/shared-server';

test.setTimeout(90_000);

test.beforeEach(async ({ mockApi: page }) => { await stubBasemapTiles(page); });

test('one Designs button opens a right-side panel with browsing and empty-map sharing', async ({ mockApi: page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await openCity(page);
  const dock = page.locator('#map-shell-bottom-right');
  await expect(dock.locator('#shareAppliedProposalsButton')).toHaveCount(0);
  await dock.locator('#proposals-button').click();
  const panel = page.locator('#proposals-sheet');
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThan(1280 / 2);
  expect(box.x + box.width).toBeGreaterThan(1250);
  await expect(panel.locator('#designs-browse')).toBeVisible();
  await panel.getByRole('tab', { name: 'Share', exact: true }).click();
  await expect(panel.locator('.share-plan-link__input')).toBeVisible();
  await expect(panel.locator('.share-plan-link__input')).toHaveValue(/at=/);
  await expect(page.locator('.cb-dialog:visible')).toHaveCount(0);
  await expect(panel.locator('#designs-browse')).toBeHidden();
  await page.mouse.click(600, 350);
  await expect(panel).toBeVisible();
  await panel.getByRole('tab', { name: 'Designs', exact: true }).click();
  await expect(panel.locator('#proposal-list-host .proposal-list-modal')).toBeVisible();
  await expect(panel.locator('#designs-share')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('designs-right-panel.png') });
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('the same panel publishes applied designs, supplies their link and releases map picking on tab change', async ({ mockApi: page }, testInfo) => {
  test.setTimeout(90_000);
  await openCity(page);
  const id = await createSpace(page, 'park');
  await page.locator('#proposals-button').click();
  const panel = page.locator('#proposals-sheet');
  await expect(panel.locator(`.proposal-list-item[data-proposal-id="${id}"]`)).toBeVisible();
  await panel.getByRole('tab', { name: 'Share', exact: true }).click();
  await expect(panel.locator('.share-plan-row')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (window as any).MapPick.active())).toBe('share');
  await panel.locator('.share-plan-publish-selected').click();
  await chooseProfileName(page, 'Panel author');
  await panel.locator('.share-plan-publish-selected').click();
  await expect(panel.locator('.share-plan-row__published')).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('.share-plan-link__input')).toHaveValue(/\/designs\/bafk/);
  expect(pageIndex(page).requests.filter(request => request.method === 'POST' && request.path === '/designs')).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('designs-share-panel.png') });
  await panel.getByRole('tab', { name: 'Designs', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).MapPick.active())).toBeNull();
  await expect(page.locator('body')).not.toHaveClass(/map-pick-mode/);
  await panel.getByRole('tab', { name: 'Share', exact: true }).click();
  await expect(panel.locator('.share-plan-row__published')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.locator('#proposals-button')).toBeFocused();
  await expect.poll(() => page.evaluate(() => (window as any).MapPick.active())).toBeNull();
});

test('phone Designs and Share use one resizable sheet and keyboard tabs', async ({ mockApi: page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCity(page);
  await page.locator('#proposals-button').click();
  const panel = page.locator('#proposals-sheet');
  await expect(panel.locator(':scope > .mobile-dock-sheet-handle')).toHaveCount(1);
  await panel.getByRole('tab', { name: 'Designs', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(panel.getByRole('tab', { name: 'Share', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('.share-plan-link__input')).toBeVisible();
  await expect(panel.locator('.mobile-dock-sheet-handle')).toHaveCount(1);
  const box = (await panel.boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.width).toBe(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: testInfo.outputPath('designs-share-phone.png') });
  await page.keyboard.press('ArrowLeft');
  await expect(panel.getByRole('tab', { name: 'Designs', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('#designs-browse')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});
