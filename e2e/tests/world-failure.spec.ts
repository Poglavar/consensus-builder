import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { stubBasemapTiles } from '../helpers/runtime';

test('a boot globe without WebGL shows a visible warning and leaves the map usable', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: any[]) {
      if (/webgl/i.test(type)) return null;
      return (getContext as any).call(this, type, ...args);
    } as typeof getContext;
  });
  await page.goto('/?world=1&city=zg&lang=en');
  await expect(page.getByRole('status').filter({ hasText: 'World view could not start.' })).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/world-view-pending/);
  await expect(page.locator('#world-view')).toHaveCount(0);
  await waitForMapReady(page);
  await page.locator('#settings-button').click();
  await expect(page.locator('#settings-sheet')).toBeVisible();
});
