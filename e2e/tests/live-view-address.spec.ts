// Copying the address after navigating a 3D scene must reproduce its mode and geographic camera.
import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { mockPhotoTiles } from '../helpers/mocks/photo-data';

for (const mode of ['model', 'photo'] as const) {
  test(`${mode} address follows camera movement, restores on reload, and clears on 2D return`, async ({ mockApi: page }) => {
    test.setTimeout(120_000);
    await stubBasemapTiles(page);
    await mockBuildingScene(page);
    if (mode === 'photo') await mockPhotoTiles(page);
    await openCity(page);
    const historyLength = await page.evaluate(() => history.length);
    const enter = async () => {
      await expect.poll(() => page.evaluate(() => (window as any).__mapModeState), { timeout: 45_000 }).toEqual({ desired: mode, pending: false });
      await expect(page.locator('#three-container canvas')).toBeVisible();
      if (mode === 'photo') {
        await expect.poll(() => page.evaluate(() => (window as any).PhotorealMode?.getLoadDiagnostics().grounded), { timeout: 20_000 }).toBe(true);
      }
    };
    await page.locator(mode === 'model' ? '#mode-3d-toggle' : '#mode-realistic-toggle').click();
    await enter();
    const flag = mode === 'model' ? '3d' : 'photo';
    await expect.poll(() => new URL(page.url()).searchParams.has(flag)).toBe(true);
    await page.evaluate(() => (window as any).applyThree3DGeoView({
      targetLat: 45.80045, targetLng: 15.9826, headingDeg: 62, pitchRad: -0.7, range: 350
    }));
    const canvas = await page.locator('#three-container canvas').boundingBox();
    if (!canvas) throw new Error('Missing 3D canvas');
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(canvas.x + canvas.width / 2 + 80, canvas.y + canvas.height / 2 + 35, { steps: 8 });
    await page.mouse.up({ button: 'right' });
    await page.mouse.wheel(0, -160);
    await expect.poll(() => page.evaluate(() => {
      const w = window as any;
      const actual = w.getThree3DGeoView();
      const encoded = w.MapShare.readCamera(new URL(location.href).searchParams.get('camera'));
      return !!encoded && Object.keys(actual).every(key => Math.abs(actual[key] - encoded[key]) < 0.000001);
    })).toBe(true);
    const copied = page.url();
    const saved = await page.evaluate(() => (window as any).MapShare.readCamera(new URL(location.href).searchParams.get('camera')));
    // A real orbit and wheel gesture changed the authored test pose, and the address captured both.
    expect(Math.abs(saved.headingDeg - 62)).toBeGreaterThan(0.1);
    expect(Math.abs(saved.pitchRad + 0.7)).toBeGreaterThan(0.01);
    expect(saved.range).toBeLessThan(350);
    const at = new URL(copied).searchParams.get('at')!.split(',').map(Number);
    expect(at[0]).toBeCloseTo(saved.targetLat, 6);
    expect(at[1]).toBeCloseTo(saved.targetLng, 6);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForMapReady(page);
    await enter();
    const restored = await page.evaluate(() => (window as any).getThree3DGeoView());
    expect(restored.targetLat).toBeCloseTo(saved.targetLat, 6);
    expect(restored.targetLng).toBeCloseTo(saved.targetLng, 6);
    expect(Math.abs(restored.headingDeg - saved.headingDeg)).toBeLessThan(0.01);
    expect(Math.abs(restored.pitchRad - saved.pitchRad)).toBeLessThan(0.001);
    expect(Math.abs(restored.range - saved.range)).toBeLessThan(0.5);
    await page.locator('#mode-2d-toggle').click();
    await expect.poll(() => page.evaluate(() => (window as any).__mapModeState)).toEqual({ desired: '2d', pending: false });
    const flat = new URL(page.url());
    for (const key of ['3d', 'photo', 'camera', 'rotate']) expect(flat.searchParams.has(key), key).toBe(false);
    await page.evaluate(() => (window as any).map.setView([45.8001, 15.982], 18, { animate: false }));
    expect(new URL(page.url()).searchParams.get('at')).toBe('45.80010,15.98200,18');
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
  });
}
