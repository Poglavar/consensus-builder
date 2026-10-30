// Highlight by use (js/building-use-highlight.js, js/ui/view-pills.js): ticking a storey use in Layers →
// Buildings colours a design's building of that use and fades the others, a view pill at the top centre
// names it, and its × turns it off. Highlight by ownership type gets the same pill.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, placeFreeformBuilding, stubBasemapTiles } from '../helpers/runtime';

test('Highlight by use colours a design by its storeys and the view pill turns it off', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await stubBasemapTiles(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  await page.locator('#parcel-info-panel .parcel-build-btn--single').click();
  await placeFreeformBuilding(page);
  await expect(page.locator('#single-land-take [data-land-status]')).toContainText('m²', { timeout: 20_000 });
  await page.locator('#single-building-confirm').click();
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .some((p: any) => p.goal === 'single' && p.applied)), { timeout: 20_000 }).toBe(true);

  // The fill of the design's drawn building, as Leaflet holds it.
  const designFill = () => page.evaluate(() => {
    const fills: string[] = [];
    (window as any).eval('proposedBuildingLayer').eachLayer((group: any) => group.eachLayer((layer: any) =>
      layer.eachLayer ? layer.eachLayer((path: any) => fills.push(`${path.options.fillColor}@${path.options.fillOpacity}`)) : null));
    return fills;
  });
  const before = await designFill();
  expect(before.length).toBeGreaterThan(0);
  const colors = await page.evaluate(() => (window as any).BuildingUseHighlight.COLORS);

  await page.locator('#layers-button').click();
  const sheet = page.locator('#layers-sheet');
  await sheet.locator('details[data-section="buildings"] > summary').click();
  const buildings = sheet.locator('details[data-section="buildings"] [data-use-highlight]');
  await buildings.getByRole('checkbox', { name: 'Housing' }).check();
  const pill = page.locator('#map-view-pills [data-view-pill="use"]');
  await expect(pill).toHaveText(/Highlighting use: Housing/);
  // A drawn Freeform building is residential: every storey is housing.
  await expect.poll(designFill).toEqual(before.map(() => `${colors.residential}@0.85`));

  await buildings.getByRole('checkbox', { name: 'Housing' }).uncheck();
  await buildings.getByRole('checkbox', { name: 'Shops' }).check();
  await expect(pill).toHaveText(/Highlighting use: Shops/);
  await expect.poll(async () => (await designFill()).every(fill => fill.endsWith('@0.06'))).toBe(true);

  await pill.getByRole('button', { name: 'Turn off this highlight' }).click();
  await expect(page.locator('#map-view-pills .map-view-pill')).toHaveCount(0);
  // The click outside closed the Layers sheet; the tick is cleared all the same.
  await expect(buildings.locator('[data-use-highlight-category="shop"]')).not.toBeChecked();
  await expect.poll(designFill).toEqual(before);

  // Highlight by ownership type shows the same kind of pill.
  await page.locator('#layers-button').click();
  await sheet.locator('details[data-section="parcels"] > summary').click();
  await sheet.locator('#highlightOwnershipGovernment').check();
  const ownership = page.locator('#map-view-pills [data-view-pill="ownership"]');
  await expect(ownership).toHaveText(/Highlighting ownership: Government/);
  await ownership.getByRole('button', { name: 'Turn off this highlight' }).click();
  await expect(sheet.locator('#highlightOwnershipGovernment')).not.toBeChecked();
  await expect(ownership).toHaveCount(0);
});
