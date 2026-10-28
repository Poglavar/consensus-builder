import { installLayerDatasets } from '../helpers/mocks/layer-datasets';
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, clickMapPoint, PARCEL_ID, closeParcel, runSelectionCommand, showSelectionDesignTab, selectionSection } from '../helpers/runtime';

test.describe('Multi-parcel selection @core', () => {
  test('Info rows temporarily distinguish parcels without changing selection or camera', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page);
    await page.locator('#parcel-manual-selection').click();
    await closeParcel(page);
    await clickMapPoint(page, 15.9829, 45.80025);
    await showSelectionDesignTab(page);
    const panel = page.locator('#parcel-info-panel');
    await panel.locator('[data-parcel-tab-id="info-tab"]').click();
    const rows = panel.locator('.selected-parcel-item');
    await expect(rows).toHaveCount(2);
    const ids = [PARCEL_ID, 'HR-335754-1235'];
    const state = () => page.evaluate(ids => {
      const w = window as any;
      return { ids:[...w.multiParcelSelection.selectedParcels].sort(), center:w.map.getCenter(), zoom:w.map.getZoom(),
        styles:ids.map(id => { const options=w.ParcelPresenter.getLayer(id).options;
          return { fill:options.fillColor, opacity:options.fillOpacity, color:options.color, weight:options.weight }; }) };
    }, ids);
    const baseline = await state();
    const first = panel.locator(`.selected-parcel-item[data-parcel-id="${ids[0]}"]`);
    const second = panel.locator(`.selected-parcel-item[data-parcel-id="${ids[1]}"]`);
    await first.hover();
    expect((await state()).styles[0]).not.toEqual(baseline.styles[0]);
    expect((await state()).styles[1]).toEqual(baseline.styles[1]);
    await page.evaluate(() => (window as any).ParcelPresenter.restoreSelectionStyles());
    expect((await state()).styles[0]).not.toEqual(baseline.styles[0]);
    await second.hover();
    expect((await state()).styles[0]).toEqual(baseline.styles[0]);
    expect((await state()).styles[1]).not.toEqual(baseline.styles[1]);
    await first.click();
    await first.press('Enter');
    expect((await state()).styles[0]).not.toEqual(baseline.styles[0]);
    const during = await state();
    expect(during.ids).toEqual(baseline.ids);
    expect(during.center).toEqual(baseline.center);
    expect(during.zoom).toBe(baseline.zoom);
    await panel.locator('[data-parcel-tab-id="propose-tab"]').click();
    expect((await state()).styles).toEqual(baseline.styles);
    await panel.locator('[data-parcel-tab-id="info-tab"]').click();
    await second.focus();
    await second.press(' ');
    expect((await state()).styles[1]).not.toEqual(baseline.styles[1]);
    await closeParcel(page);
    expect((await state()).styles).toEqual(baseline.styles);
  });
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
    await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.isActive)).toBe(false);
    await expect.poll(selected).toEqual(['HR-335754-1235']);
    await expect(section).toBeVisible();
    await expect(section.locator('.click-stack__row-title')).toHaveText('Selected parcels (1)');
    await expect(section.locator('.click-stack__body #parcel-info-panel')).toBeVisible();
    const highlightStyles = await page.evaluate(id => {
      const layer = (window as any).ParcelPresenter.getLayer(id);
      return { color: layer.options.color, fillColor: layer.options.fillColor };
    }, 'HR-335754-1235');
    expect(highlightStyles).toMatchObject({ color: '#ffdd00', fillColor: '#ffdd00' });

    // An ordinary parcel click after Done replaces the retained selection context.
    await clickMapPoint(page, 15.9822, 45.80025);
    await expect.poll(selected).toEqual([]);
    await expect.poll(() => page.evaluate(() => (window as any).selectedParcelId)).toBe(PARCEL_ID);
    await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.isActive)).toBe(false);
    await expect(selectionSection(page)).toHaveCount(0);
    await expect(page.locator('#parcel-info-panel')).toBeVisible();
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
  await page.locator('#layers-button').click();
  const layers = page.locator('#layers-sheet');
  const buildings = layers.locator('details.accordion-section[data-section="buildings"]');
  await buildings.locator(':scope > summary').click();
  await page.locator('#showBuildings').check();
  await page.locator('#layers-button').click();
  await expect(layers).toBeHidden();
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
