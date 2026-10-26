// Parcel-count requirements guide people into selection without starting an invalid design.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, closeParcel, clickMapPoint, showSelectionDesignTab, PARCEL_ID } from '../helpers/runtime';

for (const phone of [false, true]) {
  test.describe(phone ? 'phone design guidance' : 'keyboard design guidance', () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 720 }, hasTouch: phone });
    test('Row houses explains its requirement, keeps the seed parcel and enables after selecting another', async ({ mockApi: page }, testInfo) => {
      test.setTimeout(90_000);
      await openCity(page);
      await openParcel(page, 'design');
      const row = page.locator('.parcel-build-btn--row');
      const hint = 'Row houses need at least two parcels. Select another parcel or use Detect block.';
      await expect(page.locator('#parcel-info-panel .multi-select-title')).toHaveText(
        'Select a parcel to start designing. You can also select multiple parcels or a block of parcels.');
      await expect(row).toHaveAttribute('aria-disabled', 'true');
      await expect(row).toHaveAttribute('title', hint);
      await expect(row).toHaveCSS('opacity', '0.5');
      await expect(page.locator('.parcel-build-btn--buildings')).toBeEnabled();
      await expect(page.locator('.parcel-build-btn--single')).toBeEnabled();
      if (phone) {
        await row.scrollIntoViewIfNeeded();
        const box = await row.boundingBox();
        if (!box) throw new Error('Row houses tile is not visible');
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      } else {
        await row.focus();
        await page.keyboard.press('Enter');
      }
      await expect.poll(() => page.evaluate(() => ({ active: (window as any).multiParcelSelection.isActive,
        ids: [...(window as any).multiParcelSelection.selectedParcels] }))).toEqual({ active: true, ids: [PARCEL_ID] });
      await expect(page.locator('#parcel-row-selection-hint')).toBeVisible();
      await expect(page.locator('#parcel-row-selection-hint')).toHaveText(hint);
      await expect(page.locator('#rowhouse')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('one-parcel-guidance.png') });
      await closeParcel(page);
      await clickMapPoint(page, 15.9829, 45.80025);
      await showSelectionDesignTab(page);
      await expect(row).not.toHaveAttribute('aria-disabled', 'true');
      await row.click();
      await expect(page.locator('#rowhouse .on-map-editor__panel')).toBeVisible();
    });
  });
}
