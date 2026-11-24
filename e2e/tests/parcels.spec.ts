import { openLayerSection } from '../helpers/layers';
import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_GEOMETRY, PARCEL_ID, openParcel } from '../helpers/runtime';
import { mockFootprintCells } from '../helpers/mocks/building-data';

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

  test('parcels show from zoom 16 while buildings keep their zoom-17 floor', async ({ mockApi: page }) => {
    await mockFootprintCells(page, () => [{ id: 'building-in-view', geometry: PARCEL_GEOMETRY }]);
    await openCity(page);
    await openLayerSection(page, 'buildings');
    await page.locator('#showBuildings').check();
    const shown = () => page.evaluate(() => {
      const w = window as any;
      return { parcels: w.map.hasLayer(w.parcelLayer), buildings: !!w.buildingLayer && w.map.hasLayer(w.buildingLayer) };
    });
    const zoomTo = (zoom: number) => page.evaluate(z => (window as any).map.setZoom(z, { animate: false }), zoom);
    await expect.poll(shown).toEqual({ parcels: true, buildings: true });
    await zoomTo(16);
    await expect.poll(shown).toEqual({ parcels: true, buildings: false });
    await zoomTo(15.9);
    await expect.poll(shown).toEqual({ parcels: false, buildings: false });
    await zoomTo(17);
    await expect.poll(shown).toEqual({ parcels: true, buildings: true });
  });

  test('hiding parcels in 2D hides their 3D mesh and pick surface across refreshes', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 420, height: 760 });
    await openCity(page);
    const parcels = page.locator('#parcelsCheckbox');
    const switchMode = async (mode: '2d' | 'model') => {
      await page.locator(mode === 'model' ? '#mode-3d-toggle' : '#mode-2d-toggle').click();
      await expect.poll(() => page.evaluate(() => (window as any).__mapModeState)).toMatchObject({ desired: mode, pending: false });
    };
    const visibleMeshes = () => page.evaluate(id => {
      let count = 0;
      (window as any).getThreeModeInternals().scene.traverseVisible((object: any) => {
        if (object.userData.isParcel && object.userData.parcelId === id) count++;
      });
      return count;
    }, PARCEL_ID);
    const clickParcelInModel = async () => {
      const point = await page.evaluate(() => {
        const w = window as any, model = w.getThreeModeInternals();
        const [x, y] = model.latLngToXY(45.80025, 15.9822);
        const projected = new w.THREE.Vector3(x, y, 0).project(model.camera);
        const rect = model.renderer.domElement.getBoundingClientRect();
        return { x: rect.left + (1 + projected.x) * rect.width / 2, y: rect.top + (1 - projected.y) * rect.height / 2 };
      });
      await page.mouse.click(point.x, point.y);
    };
    const clickedParcels = () => page.evaluate(() => (window as any).ThreeClickStack.current()
      ?.sections.find((section: any) => section.kind === 'parcels')?.instances.map((item: any) => item.id) || []);

    await openLayerSection(page, 'parcels');
    await parcels.press('Space');
    await expect(parcels).not.toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.locator('#layers-sheet')).toBeHidden();
    await switchMode('model');
    await expect.poll(visibleMeshes).toBe(0);
    await page.setViewportSize({ width: 412, height: 740 });
    await clickParcelInModel();
    expect(await clickedParcels()).toEqual([]);
    expect(await visibleMeshes()).toBe(0);

    await switchMode('2d');
    await openLayerSection(page, 'parcels');
    await expect(parcels).not.toBeChecked();
    await parcels.press('Space');
    await expect(parcels).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.locator('#layers-sheet')).toBeHidden();
    await switchMode('model');
    await expect.poll(visibleMeshes).toBeGreaterThan(0);
    await clickParcelInModel();
    await expect.poll(clickedParcels).toContain(PARCEL_ID);
  });
});
