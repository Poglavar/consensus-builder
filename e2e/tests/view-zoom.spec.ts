// The zoom badge beside the Layers heading (js/ui/view-zoom.js): it shows the 2D map's zoom, follows a
// wheel zoom, keeps the same number across the switch to 3D, and follows the 3D camera there.
import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';

const expectedLabel = (page: any) => page.evaluate(() => {
  const w = window as any;
  return `Zoom ${w.ViewZoom.formatZoom(w.LoadView.current().zoom, w.i18n.getLocale())}`;
});

async function openLayers(page: any) {
  if (!(await page.locator('#layers-sheet').isVisible())) await page.locator('#layers-button').click();
  await expect(page.locator('#layers-sheet')).toBeVisible();
}

// A wheel turn over the map, away from the sheet on the right.
async function wheelOverMap(page: any, deltaY: number) {
  const box = await page.locator('#map').boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.wheel(0, deltaY);
}

test('the Layers heading shows the view zoom in 2D and 3D @features', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await stubBasemapTiles(page);
  await mockBuildingScene(page);
  await openCity(page);

  await openLayers(page);
  const badge = page.locator('#layers-sheet-zoom');
  await expect(badge).toHaveText('Zoom 18');
  await expect(badge).toHaveAttribute('title', /zoom/i);

  await wheelOverMap(page, -300);
  await expect.poll(() => page.evaluate(() => (window as any).map.getZoom())).toBeGreaterThan(18);
  await expect(badge).not.toHaveText('Zoom 18');
  await expect.poll(async () => (await badge.textContent()) === await expectedLabel(page)).toBe(true);

  // Back to 18, then into 3D: the camera stands for the same zoom, so the number carries over.
  await page.evaluate(() => (window as any).map.setZoom(18, { animate: false }));
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => (window as any).LoadView.current()?.mode)).toBe('3d');
  await openLayers(page);
  await expect(page.locator('#model-layer-controls')).toBeVisible();
  await expect(badge).toHaveText('Zoom 18');

  // Pulling the camera back lowers the zoom the badge reads from LoadView.
  const canvas = page.locator('#three-container canvas');
  const box = await canvas.boundingBox();
  await page.mouse.move(box!.x + box!.width * 0.3, box!.y + box!.height * 0.5);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => page.evaluate(() => (window as any).LoadView.current().zoom)).toBeLessThan(17.95);
  await expect.poll(async () => (await badge.textContent()) === await expectedLabel(page)).toBe(true);
  await expect(badge).not.toHaveText('Zoom 18');
});
