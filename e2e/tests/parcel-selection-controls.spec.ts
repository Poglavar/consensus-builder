// The selection section's Done command exits selection from any parcel panel tab.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, clickMapPoint, PARCEL_ID, closeParcel, showSelectionDesignTab, selectionSection, stackCommand, runSelectionCommand, expandSelectionSection } from '../helpers/runtime';

test('section Done exits selection after switching parcel panel tabs', async ({ mockApi: page }) => {
  await openCity(page);
  const second = 'HR-335754-1235';
  await page.evaluate(async id => (window as any).CadastralParcelRepository.ensureIds([id]), second);
  await openParcel(page);
  const detect = page.locator('.multi-select-detect-btn');
  const manual = page.locator('#parcel-manual-selection');
  await expect(detect).not.toHaveClass(/\bbtn-primary\b/);
  expect(await detect.getAttribute('aria-pressed')).toBeNull();
  await expect(manual).toHaveAttribute('aria-pressed', 'false');
  await manual.click();
  await expect(manual).toHaveAttribute('aria-pressed', 'true');
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
  }))).toEqual({ selected: 2, active: false });
  await expect(selectionSection(page)).toBeVisible();
  await expect(selectionSection(page).locator('.click-stack__row-title')).toHaveText('Selected parcels (2)');
  await expect(selectionSection(page).locator('.click-stack__body #parcel-info-panel')).toBeVisible();
  await expect(manual).toHaveAttribute('aria-pressed', 'false');
});

test('Escape and Manual toggle off keep the selected parcels and highlights', async ({ mockApi: page }) => {
  await openCity(page);
  const second = 'HR-335754-1235';
  await page.evaluate(async id => (window as any).CadastralParcelRepository.ensureIds([id]), second);
  await openParcel(page);
  const manual = page.locator('#parcel-manual-selection');
  await manual.click();
  await expect(manual).toHaveAttribute('aria-pressed', 'true');
  await closeParcel(page);
  await clickMapPoint(page, 15.9829, 45.80025);
  const selected = () => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort());
  await expect.poll(selected).toEqual([PARCEL_ID, second].sort());

  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.isActive)).toBe(false);
  await expect.poll(selected).toEqual([PARCEL_ID, second].sort());
  const section = selectionSection(page);
  await expect(section).toBeVisible();
  await expect(section.locator('.click-stack__row-title')).toHaveText('Selected parcels (2)');
  await expect(section.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'false');
  await expandSelectionSection(page);
  await expect(section.locator('.click-stack__body #parcel-info-panel')).toBeVisible();
  await expect(manual).toHaveAttribute('aria-pressed', 'false');
  const highlightStyles = await page.evaluate(ids => ids.map(id => {
    const layer = (window as any).ParcelPresenter.getLayer(id);
    return { color: layer.options.color, fillColor: layer.options.fillColor };
  }), [PARCEL_ID, second]);
  expect(highlightStyles).toEqual([
    { color: '#f57c00', fillColor: '#ff9800' },
    { color: '#f57c00', fillColor: '#ff9800' },
  ]);

  await manual.click();
  await expect(manual).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.isActive)).toBe(true);
  await expect.poll(selected).toEqual([PARCEL_ID, second].sort());
  await manual.click();
  await expect(manual).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.isActive)).toBe(false);
  await expect.poll(selected).toEqual([PARCEL_ID, second].sort());
  await expect(section).toBeVisible();
});
