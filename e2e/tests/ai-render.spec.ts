import { test, expect } from '../helpers/fixtures';
import { openCity, createBuilding } from '../helpers/runtime';
import { mockPhotoTiles } from '../helpers/mocks/photo-data';
import { mockBuildingScene } from '../helpers/mocks/building-data';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0L8AAAAASUVORK5CYII=';

test('AI scene captures real pixels and height map, validates prompt, retries generation and copies its saved share link', async ({ mockApi: page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockBuildingScene(page);
  await mockPhotoTiles(page);
  await page.route('**/ai-scene/models', route => route.fulfill({ json: { models: [
    { id: 'fixture-a', label: 'Fixture A', estUsd: 0.04, configured: true },
    { id: 'fixture-b', label: 'Fixture B', estUsd: 0.08, configured: true },
    { id: 'unavailable', label: 'Unavailable', estUsd: 0.10, configured: false },
  ], default: 'fixture-a' } }));
  const requests: any[] = [];
  await page.route('**/ai-scene/render', route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: requests.length === 1 ? 503 : 200, json: requests.length === 1
      ? { code: 'timeout', error: 'temporary failure' } : { image: png, cost_usd: 0.08, warning: 'prompt_overridden' } });
  });
  const saved: any[] = [];
  await page.route('**/ai-scene/save', route => {
    saved.push(route.request().postDataJSON());
    return route.fulfill({ json: { slug: 'fixture-render' } });
  });
  await openCity(page);
  await createBuilding(page);
  await page.locator('#mode-realistic-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible();
  await page.locator('#mode-ai-toggle').click();
  const modal = page.locator('#ai-scene-overlay');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.ai-scene-source-img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await expect.poll(() => modal.locator('.ai-scene-source-img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100);
  await modal.locator('.ai-scene-height-toggle').click();
  await expect(modal.locator('.ai-scene-height-img')).toBeVisible();
  await modal.locator('#ai-scene-model').selectOption('fixture-b');
  await expect(modal.locator('#ai-scene-model option[value="unavailable"]')).toBeDisabled();
  await modal.locator('#ai-scene-prompt').fill('');
  await modal.locator('.ai-scene-generate').click();
  await expect(modal.locator('.ai-scene-status')).toContainText('Prompt is empty');
  expect(requests).toHaveLength(0);
  await modal.locator('#ai-scene-prompt').fill('Render the existing buildings with stone facades.');
  await modal.locator('.ai-scene-generate').click();
  await expect(modal.locator('.ai-scene-status')).toContainText(/too long|temporary failure/i);
  await modal.locator('.ai-scene-generate').click();
  await expect(modal.locator('.ai-scene-result-img')).toBeVisible();
  await expect.poll(() => modal.locator('.ai-scene-result-img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await expect(modal.locator('.ai-scene-warning')).toContainText('standard server prompt');
  await expect(modal.locator('.ai-scene-status')).toContainText('0.08');
  await expect(modal.locator('.ai-scene-session-total')).toContainText('0.08');
  expect(requests[1]).toMatchObject({ model: 'fixture-b', prompt: 'Render the existing buildings with stone facades.' });
  expect(requests[1].image.length).toBeGreaterThan(1000);
  expect(requests[1].heightMap.length).toBeGreaterThan(1000);
  await modal.locator('.ai-scene-copy').click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toContain('fixture-render');
  expect(saved[0]).toMatchObject({ image: png, city: 'zg', model: 'fixture-b' });
  await expect(modal.locator('.ai-scene-tweet')).toHaveAttribute('href', /twitter\.com\/intent\/tweet/);
  const downloadPromise = page.waitForEvent('download');
  await modal.locator('.ai-scene-download').click();
  expect((await downloadPromise).suggestedFilename()).toBe('ai-scene.png');
  await modal.locator('.ai-scene-close').click();
  await expect(modal).toBeHidden();
  await expect(page.locator('#three-container canvas')).toBeVisible();
});

for (const delay of [0, 900, 1800]) {
test(`a shared AI scene arriving after ${delay}ms restores its camera and offers image expansion and dismissal`, async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  const view = { targetLng: 15.9822, targetLat: 45.80025, headingDeg: 35, pitchRad: -Math.PI / 4, range: 120 };
  await page.route('**/ai-scene/scene/fixture-shared', async route => {
    await new Promise(resolve => setTimeout(resolve, delay));
    await route.fulfill({ json: { imageUrl: png, view } });
  });
  await page.goto('/?city=zg&model&scene=fixture-shared&reduceMotion=1');
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 15000 });
  const card = page.locator('.ai-scene-follow-card');
  await expect(card).toBeVisible();
  await expect(card.locator('img')).toHaveAttribute('src', png);
  await expect.poll(() => card.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).getThree3DGeoView()?.targetLat)).toBeCloseTo(view.targetLat, 5);
  await expect.poll(() => page.evaluate(() => (window as any).getThree3DGeoView()?.headingDeg)).toBeCloseTo(view.headingDeg, 1);
  const restored = await page.evaluate(() => (window as any).getThree3DGeoView());
  expect(restored.targetLng).toBeCloseTo(view.targetLng, 5);
  expect(restored.headingDeg).toBeCloseTo(view.headingDeg, 1);
  expect(restored.pitchRad).toBeCloseTo(view.pitchRad, 2);
  expect(restored.range).toBeCloseTo(view.range, 0);
  await card.locator('img').click();
  await expect(card).toHaveClass(/expanded/);
  await card.locator('img').click();
  await expect(card).not.toHaveClass(/expanded/);
  await card.locator('.ai-scene-follow-close').click();
  await expect(card).toBeHidden();
  await page.locator('#mode-2d-toggle').click();
  await expect(page.locator('#map')).toBeVisible();
});
}
