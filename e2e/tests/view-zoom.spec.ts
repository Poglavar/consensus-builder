// The zoom bubble on the Layers button (js/ui/view-zoom.js): it shows the 2D map's zoom, follows a wheel
// zoom, keeps the same number across the switch to 3D, follows the 3D camera there, and describes the
// button as "Zoom N" to assistive technology.
import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';

const expectedZoom = (page: any) => page.evaluate(() => {
  const w = window as any;
  return w.ViewZoom.formatZoom(w.LoadView.current().zoom, w.i18n.getLocale());
});

test('the Layers button shows the view zoom in 2D and 3D @features', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await stubBasemapTiles(page);
  await mockBuildingScene(page);
  await openCity(page);

  const button = page.locator('#layers-button');
  const bubble = button.locator('#layers-button-zoom');
  await expect(bubble).toBeVisible();
  await expect(bubble).toHaveText('18');
  await expect(bubble).toHaveAttribute('title', /zoom/i);
  await expect(button).toHaveAccessibleName('Layers');
  await expect(button).toHaveAccessibleDescription('Zoom 18');

  // A wheel turn over the middle of the map.
  const map = await page.locator('#map').boundingBox();
  await page.mouse.move(map!.x + map!.width * 0.4, map!.y + map!.height * 0.5);
  await page.mouse.wheel(0, -300);
  await expect.poll(() => page.evaluate(() => (window as any).map.getZoom())).toBeGreaterThan(18);
  await expect(bubble).not.toHaveText('18');
  await expect.poll(async () => (await bubble.textContent()) === await expectedZoom(page)).toBe(true);

  // Back to 18, then into 3D: the camera stands for the same zoom, so the number carries over.
  await page.evaluate(() => (window as any).map.setZoom(18, { animate: false }));
  await expect(bubble).toHaveText('18');
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => (window as any).LoadView.current()?.mode)).toBe('3d');
  await expect(bubble).toBeVisible();
  await expect(bubble).toHaveText('18');

  // Pulling the camera back lowers the zoom the bubble reads from LoadView.
  const canvas = await page.locator('#three-container canvas').boundingBox();
  await page.mouse.move(canvas!.x + canvas!.width * 0.4, canvas!.y + canvas!.height * 0.5);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => page.evaluate(() => (window as any).LoadView.current().zoom)).toBeLessThan(17.95);
  await expect.poll(async () => (await bubble.textContent()) === await expectedZoom(page)).toBe(true);
  await expect(bubble).not.toHaveText('18');
  await expect(button).toHaveAccessibleDescription(/^Zoom \d/);
});
