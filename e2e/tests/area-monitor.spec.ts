import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { installAreaMonitorSpaFallback } from '../helpers/mocks/area-monitor-server';

// Watched areas (draw controls and the monitor list) live in the Activity sheet since fbe3758d.
async function openWatchedAreas(page: import('@playwright/test').Page) {
  await page.locator('#activity-button').click();
  await expect(page.locator('#activity-sheet [data-section="areaMonitor"]')).toBeVisible();
}
// The address follows the map as ?at= (map-core.js), so a route is checked by path and city only.
async function expectRoute(page: import('@playwright/test').Page, pathname: string, city: string) {
  await expect.poll(() => {
    const url = new URL(page.url());
    return { pathname: url.pathname, city: url.searchParams.get('city') };
  }).toEqual({ pathname, city });
}

test.describe('Area monitor @features', () => {
  test('draw control enters and Escape exits real polygon drawing mode', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await openWatchedAreas(page);
    const draw = page.locator('#areaMonitorDrawButton');
    await draw.click();
    await expect(draw).toHaveClass(/active/);
    await expect(page.locator('.leaflet-container').first()).toHaveCSS('cursor', 'crosshair');
    await page.keyboard.press('Escape');
    await expect(draw).not.toHaveClass(/active/);
  });

  test('a real monitor route loads detail, supports minimize and closes', async ({ mockApi: page }) => {
    await installAreaMonitorSpaFallback(page);
    await page.goto('/monitors/1?city=zg');
    await waitForMapReady(page);
    const panel = page.locator('#map-container #area-monitor-detail-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.panel-header h3')).toHaveText('Zapadni Jarunski Most');
    await expect(panel.locator('.area-monitor-detail-summary__percent')).toHaveText('33%');
    await expect(panel.locator('.area-monitor-detail-summary__meta')).toContainText('1 / 3');
    await expect(panel.locator('.area-monitor-detail-links a')).toHaveCount(2);
    await expect(panel.locator('#am-share')).toBeVisible();
    const minimize = panel.locator('#am-detail-minimize');
    await minimize.click();
    await expect(panel).toHaveClass(/is-minimized/);
    await expect(panel.locator('.panel-body')).toBeHidden();
    await minimize.click();
    await expect(panel.locator('.panel-body')).toBeVisible();
    await panel.locator('#am-detail-close').click();
    await expect(page.locator('#area-monitor-detail-panel')).toHaveCount(0);
    await expectRoute(page, '/', 'zg');
  });

  test('list opens from Tools and selecting an item follows the actual monitor route', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await openWatchedAreas(page);
    // The list is inline in the Activity sheet now (fbe3758d), not a modal behind a List button.
    const list = page.locator('#activity-watched-areas-list');
    await expect(list).toBeVisible();
    await expect(list).toContainText('Zapadni Jarunski Most');
    await expect(list).toContainText('Vukovarska Corridor');
    await list.getByRole('button', { name: /Zapadni Jarunski Most/ }).click();
    await expect(page).toHaveURL(/\/monitors\/1$/);
    expect(await page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId())).toBe('zagreb');
    await expect(page.locator('#area-monitor-detail-panel')).toBeVisible();
    await expect(page.locator('#area-monitor-list-modal')).toHaveCount(0);
    // On a phone the sheet folds away so the selected area has the map.
    await expect(page.locator('#activity-sheet')).toBeHidden();
  });

  test('wrong-city route can be cancelled without rendering or changing city', async ({ mockApi: page }) => {
    await installAreaMonitorSpaFallback(page);
    await page.goto('/monitors/1?city=bg');
    await waitForMapReady(page);
    const prompt = page.getByRole('alertdialog').filter({ hasText: /created for Zagreb.*current city is Belgrade/s });
    await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: /cancel/i }).click();
    await expectRoute(page, '/', 'bg');
    await expect(page.locator('#area-monitor-detail-panel')).toHaveCount(0);
    await expect(page.locator('#area-monitor-list-modal')).toHaveCount(0);
  });
});
