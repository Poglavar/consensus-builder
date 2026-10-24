import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles } from '../helpers/runtime';

test('shared-plan progress stays compact across mobile and desktop widths', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubBasemapTiles(page);
  await openCity(page);
  await page.evaluate(() => {
    const w = window as any;
    w.showProposalLoadOverlay('Loading shared designs…', { title: 'Opening shared designs', total: 17 });
    w.updateProposalLoadOverlay({ progress: { done: 5, total: 17 } });
  });
  const card = page.locator('.proposal-load-card');
  const bar = page.locator('.proposal-load-progress-bar');
  const fill = page.locator('.proposal-load-progress-fill');
  await expect(bar).toBeVisible();
  for (const width of [390, 320, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(card).toBeInViewport({ ratio: 1 });
    await expect.poll(async () => (await bar.boundingBox())!.height).toBeLessThanOrEqual(8);
    expect((await bar.boundingBox())!.height).toBeGreaterThan(0);
    expect((await card.boundingBox())!.height).toBeLessThan(300);
    await expect.poll(async () => (await fill.boundingBox())!.width / (await bar.boundingBox())!.width).toBeCloseTo(5 / 17, 2);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const initialHeight = (await card.boundingBox())!.height;
  await page.evaluate(() => (window as any).updateProposalLoadOverlay({
    status: 'Preparing cadastral ground for the selected buildings, parks, squares and roads…',
    progress: { done: 12, total: 17 }
  }));
  await expect(page.locator('.proposal-load-progress-text')).toHaveText('12 / 17');
  await expect.poll(async () => (await fill.boundingBox())!.width / (await bar.boundingBox())!.width).toBeCloseTo(12 / 17, 2);
  expect((await card.boundingBox())!.height).toBe(initialHeight);
  await page.evaluate(() => (window as any).hideProposalLoadOverlay());
  await expect(card).toBeHidden();
});
