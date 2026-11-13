import { openLayerSection } from '../helpers/layers';
import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID, openParcel } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';

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
    await openLayerSection(page, 'parcels');
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

  test('parcels show from zoom 15 while buildings keep their zoom-17 floor', async ({ mockApi: page }) => {
    await mockBuildingScene(page);
    await openCity(page);
    await openLayerSection(page, 'buildings');
    await page.locator('#showBuildings').check();
    const shown = () => page.evaluate(() => {
      const w = window as any;
      return { parcels: w.map.hasLayer(w.parcelLayer), buildings: !!w.buildingLayer && w.map.hasLayer(w.buildingLayer) };
    });
    const zoomTo = (zoom: number) => page.evaluate(z => (window as any).map.setZoom(z, { animate: false }), zoom);
    await expect.poll(shown).toEqual({ parcels: true, buildings: true });
    await zoomTo(15);
    await expect.poll(shown).toEqual({ parcels: true, buildings: false });
    await zoomTo(14.9);
    await expect.poll(shown).toEqual({ parcels: false, buildings: false });
    await zoomTo(17);
    await expect.poll(shown).toEqual({ parcels: true, buildings: true });
  });
});
