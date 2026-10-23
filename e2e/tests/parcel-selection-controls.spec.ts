// The multi-parcel inspector must let users abandon their selection through its own button.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, clickMapPoint, PARCEL_ID, closeParcel } from '../helpers/runtime';

test('multi-parcel inspector Cancel selection clears the selected land and exits selection mode', async ({ mockApi: page }) => {
  await openCity(page);
  const second = 'HR-335754-1235';
  await page.evaluate(async id => (window as any).CadastralParcelRepository.ensureIds([id]), second);
  await openParcel(page);
  await page.locator('#multiSelectCheckboxInfo').check();
  await closeParcel(page);
  await clickMapPoint(page, 15.9829, 45.80025);
  await expect.poll(() => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort()))
    .toEqual([PARCEL_ID, second].sort());
  await page.locator('#selection-tray [data-command="selection.propose"]').click();
  await page.locator('#parcel-info-panel [data-i18n-key="panel.parcel.tabInfo"]').click();
  await page.locator('#parcel-info-panel button[onclick="cancelMultiParcelSelection()"]').click();
  await expect.poll(() => page.evaluate(() => ({
    selected: (window as any).multiParcelSelection.selectedParcels.size,
    active: (window as any).multiParcelSelection.isActive,
  }))).toEqual({ selected: 0, active: false });
  await expect(page.locator('#selection-tray')).toBeHidden();
  await expect(page.locator('#multiSelectCheckboxInfo')).not.toBeChecked();
});
