import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, PARCEL_ID } from '../helpers/runtime';

test.describe('Parcel selection and ownership @core', () => {
  test('clicking a repository parcel opens its menu and selects its live feature', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page);

    await expect(page.locator('#parcel-info-panel')).toBeVisible();
    const selected = await page.evaluate(() => {
      const w = window as any;
      const feature = w.LiveParcelFabric.get(w.selectedParcelId);
      return {
        id: w.selectedParcelId,
        layerId: feature?.properties?.parcelId,
        provenance: w.LiveParcelFabric.explicitCadastreIds(feature),
      };
    });
    expect(selected.id).toBe(PARCEL_ID);
    expect(selected.layerId).toBe(PARCEL_ID);
    expect(selected.provenance).toEqual([PARCEL_ID]);
  });
});
