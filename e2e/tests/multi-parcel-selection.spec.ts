import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, clickMapPoint, PARCEL_ID } from '../helpers/runtime';

test.describe('Multi-parcel selection @core', () => {
  test('tray tracks clicks, deselection, clearing and Done', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page);
    await page.locator('#multiSelectCheckboxInfo').check();
    const selected = () => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort());
    await expect.poll(selected).toEqual([PARCEL_ID]);
    await page.locator('#parcel-info-panel .close-button').click();
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
    await page.locator('#multiSelectCheckboxInfo').check();
    await page.locator('#parcel-info-panel .close-button').click();
    await clickMapPoint(page, 15.9829, 45.80025);
    await page.locator('#selection-tray [data-command="selection.propose"]').click();
    await expect(page.locator('.parcel-build-palette')).toBeVisible();
    expect(await page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort())).toEqual([PARCEL_ID, 'HR-335754-1235']);
  });
});
