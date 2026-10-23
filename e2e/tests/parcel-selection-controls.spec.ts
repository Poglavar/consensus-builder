// The selection section's Done command exits selection from any parcel panel tab.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, clickMapPoint, PARCEL_ID, closeParcel, showSelectionDesignTab, selectionSection, stackCommand, runSelectionCommand } from '../helpers/runtime';

test('section Done exits selection after switching parcel panel tabs', async ({ mockApi: page }) => {
  await openCity(page);
  const second = 'HR-335754-1235';
  await page.evaluate(async id => (window as any).CadastralParcelRepository.ensureIds([id]), second);
  await openParcel(page);
  await page.locator('#parcel-manual-selection').click();
  await closeParcel(page);
  await clickMapPoint(page, 15.9829, 45.80025);
  await expect.poll(() => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort()))
    .toEqual([PARCEL_ID, second].sort());
  await showSelectionDesignTab(page);
  await page.locator('#parcel-info-panel [data-i18n-key="panel.parcel.tabInfo"]').click();
  await expect(stackCommand(page, 'selection.done')).toBeVisible();
  await runSelectionCommand(page, 'selection.done');
  await expect.poll(() => page.evaluate(() => ({
    selected: (window as any).multiParcelSelection.selectedParcels.size,
    active: (window as any).multiParcelSelection.isActive,
  }))).toEqual({ selected: 0, active: false });
  await expect(selectionSection(page)).toHaveCount(0);
  await expect(page.locator('#parcel-manual-selection')).toHaveAttribute('aria-pressed', 'false');
});
