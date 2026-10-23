import { installLayerDatasets } from '../helpers/mocks/layer-datasets';
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, clickMapPoint, PARCEL_ID, closeParcel } from '../helpers/runtime';

test.describe('Multi-parcel selection @core', () => {
  test('tray tracks clicks, deselection, clearing and Done', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page);
    await page.locator('#parcel-manual-selection').click();
    const selected = () => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort());
    await expect.poll(selected).toEqual([PARCEL_ID]);
    await closeParcel(page);
    await clickMapPoint(page, 15.9829, 45.80025);
    await expect.poll(selected).toEqual([PARCEL_ID, 'HR-335754-1235']);
    await expect(page.locator('.selection-tray__count')).toContainText('2');
    await expect(page.locator('.selection-tray__area')).toContainText('m²');
    await clickMapPoint(page, 15.9829, 45.80025);
    await expect.poll(selected).toEqual([PARCEL_ID]);
    await page.locator('#selection-tray [data-command="selection.clear"]').click();
    await expect.poll(selected).toEqual([]);
    await page.locator('#selection-tray [data-command="selection.done"]').click();
    await expect(page.locator('#selection-tray')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).multiParcelSelection.isActive)).toBe(false);
  });
  test('Propose opens the build palette for the selection', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page);
    await page.locator('#parcel-manual-selection').click();
    await closeParcel(page);
    await clickMapPoint(page, 15.9829, 45.80025);
    await page.locator('#selection-tray [data-command="selection.propose"]').click();
    await expect(page.locator('.parcel-build-palette')).toBeVisible();
    expect(await page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort())).toEqual([PARCEL_ID, 'HR-335754-1235']);
  });
});

// The source building is a real fetched map feature, above the cadastral fill.
test('manual mode picks parcels through existing buildings without opening the click stack', async ({ mockApi: page }) => {
  await installLayerDatasets(page);
  await openCity(page);
  await expect.poll(() => page.evaluate(() => (window as any).buildingsAt({ lat: 45.80021, lng: 15.98212 }).length)).toBeGreaterThan(0);
  await openParcel(page);
  const manual = page.locator('#parcel-manual-selection');
  await manual.click();
  await expect(manual).toHaveAttribute('aria-pressed', 'true');
  await closeParcel(page);
  await page.locator('#selection-tray [data-command="selection.clear"]').click();
  await clickMapPoint(page, 15.98212, 45.80021);
  await expect.poll(() => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels])).toEqual([PARCEL_ID]);
  await expect(page.locator('#click-stack')).toBeHidden();
  await expect(page.locator('#planning-inspector')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(manual).toHaveAttribute('aria-pressed', 'false');
});
