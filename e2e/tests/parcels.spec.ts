import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID, openParcel } from '../helpers/runtime';

test.describe('Parcel loading and rendering @core', () => {
  test('API parcels reach the repository, live fabric and clickable map projection', async ({ mockApi: page }) => {
    await openCity(page);
    const result = await page.evaluate(id => {
      const w = window as any;
      return { repository: w.CadastralParcelRepository.get(id), fabric: w.LiveParcelFabric.get(id), layer: !!w.ParcelPresenter.getLayer(id), visible: w.map.hasLayer(w.parcelLayer) };
    }, PARCEL_ID);
    expect(result.repository.geometry.type).toBe('Polygon');
    expect(result.fabric.geometry.type).toBe('Polygon');
    expect(result.fabric.properties.cadastreParcelIds).toEqual([PARCEL_ID]);
    expect(result.layer).toBe(true);
    expect(result.visible).toBe(true);
    await openParcel(page);
    await expect(page.locator('#parcel-info-title')).toContainText(PARCEL_ID);
  });

  test('parcel layer visibility changes the map while retaining cadastral facts', async ({ mockApi: page }) => {
    await openCity(page);
    await page.locator('#layers-button').click();
    await page.locator('#parcelsCheckbox').uncheck();
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).parcelLayer))).toBe(false);
    expect(await page.evaluate(id => !!(window as any).CadastralParcelRepository.get(id), PARCEL_ID)).toBe(true);
    await page.locator('#parcelsCheckbox').check();
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).parcelLayer))).toBe(true);
  });

  test('zooming out hides parcels and returning to parcel zoom restores them', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => (window as any).map.setZoom(12, { animate: false }));
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).parcelLayer))).toBe(false);
    await page.evaluate(() => (window as any).map.setZoom(18, { animate: false }));
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).parcelLayer))).toBe(true);
  });
});
