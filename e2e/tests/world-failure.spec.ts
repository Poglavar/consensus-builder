// A failed globe leaves a visible explanation and usable map controls at each entry point.
import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { openCity, stubBasemapTiles } from '../helpers/runtime';

async function disableWebGL(page: Page) {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: any[]) {
      if (/webgl/i.test(type)) return null;
      return (getContext as any).call(this, type, ...args);
    } as typeof getContext;
  });
}

test('a boot globe without WebGL shows a visible warning and leaves the map usable', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await disableWebGL(page);
  await page.goto('/?world=1&city=zg&lang=en');
  await expect(page.getByRole('status').filter({ hasText: 'World view could not start.' })).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/world-view-pending/);
  await expect(page.locator('#world-view')).toHaveCount(0);
  await waitForMapReady(page);
  await page.locator('#settings-button').click();
  await expect(page.locator('#settings-sheet')).toBeVisible();
});

for (const width of [1188, 500]) {
  test(`the city chip explains unavailable WebGL and preserves city search at ${width}px`, async ({ mockApi: page }) => {
    await page.setViewportSize({ width, height: 761 });
    await stubBasemapTiles(page);
    await disableWebGL(page);
    await openCity(page);
    const chip = page.locator('.map-search__chip');
    await chip.click();
    await expect(page.getByRole('status').filter({ hasText: 'World view could not start.' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'World view could not start.' })).toContainText('search for another city');
    await expect(page.locator('#world-view')).toHaveCount(0);
    await expect(chip).not.toHaveClass(/cb-busy/);
    await expect(chip).not.toHaveAttribute('aria-busy');
    await expect(page.locator('#map')).toBeVisible();

    await page.locator('.map-search__icon-button').click();
    await page.locator('#map-search-input').fill('Belgrade');
    await expect(page.locator('.map-search__results [role="option"]').filter({ hasText: /^Belgrade/ }).first()).toBeVisible();
  });
}
