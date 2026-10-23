import { installLayerDatasets } from '../helpers/mocks/layer-datasets';
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, clickMapPoint, PARCEL_ID, closeParcel, runSelectionCommand, showSelectionDesignTab, selectionSection } from '../helpers/runtime';

test.describe('Multi-parcel selection @core', () => {
  test('selection section tracks zero and nonzero counts, map picks, Clear and Done', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page);
    await page.locator('#parcel-manual-selection').click();
    const selected = () => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort());
    await expect.poll(selected).toEqual([PARCEL_ID]);
    const section = selectionSection(page);
    await expect(section).toBeVisible();
    await expect(section.locator('.click-stack__row-title')).toHaveText('Selected parcels (1)');
    await expect(section.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'true');
    const oneParcelArea = await section.locator('.click-stack__row-detail').textContent();
    await closeParcel(page);
    await expect(section.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'false');
    await clickMapPoint(page, 15.9829, 45.80025);
    await expect.poll(selected).toEqual([PARCEL_ID, 'HR-335754-1235']);
    await expect(section).toBeVisible();
    await expect(section.locator('.click-stack__row-title')).toHaveText('Selected parcels (2)');
    const twoParcelArea = await section.locator('.click-stack__row-detail').textContent();
    expect(twoParcelArea).toContain('m²');
    expect(twoParcelArea).not.toBe(oneParcelArea);
    await expect(section.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'false');
    await clickMapPoint(page, 15.9829, 45.80025);
    await expect.poll(selected).toEqual([PARCEL_ID]);
    await runSelectionCommand(page, 'selection.clear');
    await expect.poll(selected).toEqual([]);
    await expect(section.locator('.click-stack__row-title')).toHaveText('Selected parcels (0)');
    await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.isActive)).toBe(true);
    await clickMapPoint(page, 15.9829, 45.80025);
    await expect.poll(selected).toEqual(['HR-335754-1235']);
    await expect(section.locator('.click-stack__row-title')).toHaveText('Selected parcels (1)');
    await runSelectionCommand(page, 'selection.done');
    await expect(section).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).multiParcelSelection.isActive)).toBe(false);
  });
  test('Design tab opens the build palette for the selection', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page);
    await page.locator('#parcel-manual-selection').click();
    await closeParcel(page);
    await clickMapPoint(page, 15.9829, 45.80025);
    await showSelectionDesignTab(page);
    await expect(page.locator('.parcel-build-palette')).toBeVisible();
    expect(await page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort())).toEqual([PARCEL_ID, 'HR-335754-1235']);
  });
});

// The source building is a real fetched map feature, above the cadastral fill.
test('manual mode picks parcels through existing buildings without inspecting building content', async ({ mockApi: page }) => {
  await installLayerDatasets(page);
  await openCity(page);
  await expect.poll(() => page.evaluate(() => (window as any).buildingsAt({ lat: 45.80021, lng: 15.98212 }).length)).toBeGreaterThan(0);
  await openParcel(page);
  const manual = page.locator('#parcel-manual-selection');
  await manual.click();
  await expect(manual).toHaveAttribute('aria-pressed', 'true');
  await closeParcel(page);
  await runSelectionCommand(page, 'selection.clear');
  await clickMapPoint(page, 15.98212, 45.80021);
  await expect.poll(() => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels])).toEqual([PARCEL_ID]);
  await expect(selectionSection(page)).toBeVisible();
  await expect(page.locator('#planning-inspector')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(manual).toHaveAttribute('aria-pressed', 'false');
});
