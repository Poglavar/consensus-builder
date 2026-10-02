import { test, expect } from '../helpers/fixtures';
import { openCity, clickMapPoint, createSpace } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';

test.describe('World navigation and open ground @features', () => {
  test('the world globe searches a live city and opens its configured map', async ({ mockApi: page }) => {
    await openCity(page);
    await page.locator('#settings-button').click();
    await page.locator('#world-view-button').click();
    const world = page.locator('#world-view');
    await expect(world).toBeVisible();
    await expect(world.locator('canvas')).toBeVisible();
    await world.locator('.world-search__input').fill('Belgrade');
    await world.getByRole('option').filter({ hasText: 'Belgrade' }).first().click();
    await expect(world.locator('.world-popup__title')).toHaveText('Belgrade');
    await world.getByRole('button', { name: /Open Belgrade/ }).click();
    await waitForMapReady(page);
    await expect(world).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId())).toBe('belgrade');
  });

  test('requesting an available data source retries a failed request then opens exploration', async ({ mockApi: page }) => {
    let attempts = 0;
    let request: any;
    await page.route('**/cities/requests', route => {
      request = route.request().postDataJSON();
      return route.fulfill({ status: ++attempts === 1 ? 503 : 200, json: { ok: true } });
    });
    await openCity(page);
    await page.locator('#settings-button').click();
    await page.locator('#world-view-button').click();
    const world = page.locator('#world-view');
    await world.locator('.world-search__input').fill('Dhaka');
    await world.getByRole('option').filter({ hasText: 'Dhaka' }).first().click();
    await world.getByRole('button', { name: 'Ask for this city' }).click();
    await expect(world.locator('.world-popup__error')).toHaveText('Could not send the request. Try again?');
    await world.getByRole('button', { name: 'Ask for this city' }).click();
    await expect(world.getByRole('button', { name: 'Request noted, thank you' })).toBeDisabled();
    expect(attempts).toBe(2);
    expect(request).toMatchObject({ name: 'Dhaka' });
    await world.getByRole('button', { name: 'Open the map here' }).click();
    await waitForMapReady(page);
    await expect.poll(() => page.evaluate(() => (window as any).CityConfigManager.isExplore())).toBe(true);
    await expect.poll(() => page.evaluate(() => Math.abs((window as any).map.getCenter().lat - 23.7104))).toBeLessThan(0.001);
  });

  test('open ground can draw a site and cancel it without binding an unrelated parcel', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => (window as any).map.setView([45.8008, 15.9817], 18, { animate: false }));
    await clickMapPoint(page, 15.9817, 45.8008);
    await expect(page.locator('#ground-menu')).toBeVisible();
    await page.locator('#ground-menu [data-command="ground.drawSite"]').click();
    await expect(page.locator('#site-panel')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).SiteTool.isActive())).toBe(true);
    await page.locator('#site-panel [data-site-action="cancel"]').first().click();
    await expect(page.locator('#site-panel')).toBeHidden();
    expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(0);
  });

  test('urbanist inspection scores actual applied parcel geometry and restores the map when closed', async ({ mockApi: page }) => {
    await openCity(page);
    await createSpace(page, 'park');
    await page.locator('#proposals-button').click();
    await page.locator('#roosterScoreButton').click();
    const panel = page.locator('#grain-score-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-grain-role="result"]')).toBeVisible({ timeout: 20000 });
    const score = Number(await panel.locator('[data-grain-role="totalScore"]').innerText());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    await panel.locator('.grain-score-methodology summary').click();
    await expect(panel.locator('[data-grain-role="methodologyBody"]')).toBeVisible();
    await panel.locator('[data-grain-action="sound"]').click();
    await expect(panel.locator('[data-grain-action="sound"]')).toHaveAttribute('aria-pressed', 'false');
    await panel.locator('[data-grain-action="close"]').click();
    await expect(panel).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).map.dragging.enabled())).toBe(true);
  });
});
