import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace } from '../helpers/runtime';
import { mockPhotoTiles } from '../helpers/mocks/photo-data';
import { mockBuildingScene } from '../helpers/mocks/building-data';

test('walk chooses a real 3D ground point, cancels with Escape, and opens the configured walking map', async ({ mockApi: page, context }) => {
  await mockBuildingScene(page);
  await openCity(page);
  const walkUrl = await page.evaluate(() => (window as any).CityConfigManager.getWalkConfig().url);
  await context.route(`${walkUrl}**`, route => route.fulfill({ contentType: 'text/html', body: '<title>Walk handoff fixture</title>' }));
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible();
  const walk = page.locator('#mode-walk-toggle');
  await expect(walk).toBeVisible();
  await walk.click();
  await expect(page.locator('#three-container')).toHaveClass(/three-mode-walk-pick/);
  await expect(page.locator('#floating-status-text')).toContainText('Click the ground');
  await page.keyboard.press('Escape');
  await expect(page.locator('#three-container')).not.toHaveClass(/three-mode-walk-pick/);
  const newPage = context.waitForEvent('page');
  await walk.click();
  await page.locator('#three-container canvas').click();
  const destination = await newPage;
  try {
    await destination.waitForURL(url => url.origin === new URL(walkUrl).origin && url.pathname === new URL(walkUrl).pathname);
    const url = new URL(destination.url());
    expect(url.searchParams.get('st3d')).toBe('walk');
    expect(Number(url.searchParams.get('lat'))).toBeCloseTo(45.80025, 2);
    expect(Number(url.searchParams.get('lon'))).toBeCloseTo(15.9822, 2);
    await expect(page.locator('#three-container')).not.toHaveClass(/three-mode-walk-pick/);
  } finally { await destination.close(); }
});

test('walk requires publishing local applied proposals and cancelling preserves the model scene', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await openCity(page);
  await createSpace(page, 'park');
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible();
  await page.locator('#mode-walk-toggle').click();
  await expect(page.locator('.share-modal-overlay')).toBeVisible();
  await expect(page.locator('.share-modal-overlay')).toContainText(/upload|publish/i);
  await page.locator('.share-modal-close').click();
  await expect(page.locator('.share-modal-overlay')).toBeHidden();
  await expect(page.locator('#three-container canvas')).toBeVisible();
  expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p: any) => p.applied).length)).toBe(1);
});

test('Photo view enters the actual tiles renderer and returning to 2D releases its scene', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  const tiles = await mockPhotoTiles(page);
  await openCity(page);
  await page.locator('#mode-realistic-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 15000 });
  await expect.poll(tiles.requests, { timeout: 20000 }).toBeGreaterThan(0);
  await expect(page.locator('body')).toHaveClass(/realistic-mode-active/);
  await expect.poll(() => page.evaluate(() => {
    const mesh = (window as any).getThreeModeInternals().scene.getObjectByName('FixturePhotorealMesh');
    if (!mesh?.isMesh || !mesh.geometry?.attributes?.position?.count) return false;
    let object = mesh;
    while (object) { if (!object.visible) return false; object = object.parent; }
    return true;
  }), { timeout: 20000 }).toBe(true);
  await page.locator('#mode-2d-toggle').click();
  await expect(page.locator('body')).not.toHaveClass(/realistic-mode-active/);
  await expect(page.locator('#three-container')).toBeHidden();
  await expect(page.locator('#map')).toBeVisible();
});
