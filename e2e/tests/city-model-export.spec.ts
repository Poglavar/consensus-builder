// CityJSON beside our own files (js/city-json-export.js): a saved Freeform building downloads from its
// design card as a CityJSON 2.0 file with the building, its design group and the plan file inside, and
// Lists → Import reads it back as that plan; a city model without one is pointed to Upload footprints.
import { readFileSync } from 'node:fs';
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, placeFreeformBuilding, showProposal, stubBasemapTiles } from '../helpers/runtime';

test('Download design offers CityJSON beside the editable plan and GeoJSON, and Lists imports it back', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await stubBasemapTiles(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  await page.locator('#parcel-info-panel .parcel-build-btn--single').click();
  await placeFreeformBuilding(page);
  await expect(page.locator('#single-land-take [data-land-status]')).toContainText('m²', { timeout: 20_000 });
  await page.locator('#single-building-confirm').click();
  const saved = () => page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.goal === 'single' && p.applied) || null);
  await expect.poll(saved, { timeout: 20_000 }).not.toBeNull();
  const record = await saved();
  await showProposal(page, record.proposalId);
  await page.locator('#click-stack').getByRole('button', { name: 'Download', exact: true }).click();
  const dialog = page.locator('.cb-dialog').filter({ hasText: 'Download design' });
  await expect(dialog.locator('[data-plan-file-action]')).toHaveCount(3);
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download CityJSON', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.city\.json$/);
  const doc = JSON.parse(readFileSync(await file.path(), 'utf8'));
  expect(doc).toMatchObject({ type: 'CityJSON', version: '2.0', metadata: { referenceSystem: 'https://www.opengis.net/def/crs/EPSG/0/32633' } });
  const objects = Object.values(doc.CityObjects) as any[];
  const building = objects.find(o => o.type === 'Building');
  expect(building.attributes.measuredHeight).toBe(record.geometry.buildings[0].properties.height);
  expect(building.geometry[0].semantics.surfaces.map((s: any) => s.type)).toEqual(['GroundSurface', 'WallSurface', 'RoofSurface']);
  expect(doc.CityObjects['ugt-plan'].attributes.ugtPlanFile.designs).toHaveLength(1);
  // The same file reads back through the site's own reader as one building.
  const read = await page.evaluate(text => (window as any).CityModelReader.readCityModel(text).buildings.length, JSON.stringify(doc));
  expect(read).toBe(1);

  // Lists → Plans → Import reads the file back as the plan it carries.
  await page.keyboard.press('Escape');
  await page.locator('#proposals-button').click();
  const sheet = page.locator('#proposals-sheet');
  await sheet.getByRole('tab', { name: 'Plans', exact: true }).click();
  const choose = (kind: string, name: string, value: unknown) => sheet.locator(`#lists-actions input[data-lists-import-input="${kind}"]`)
    .setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
  await choose('plans', file.suggestedFilename(), doc);
  const review = page.locator('.cb-dialog').filter({ hasText: 'Review plan file' });
  await expect(review).toBeVisible();
  await expect(review).not.toContainText('differ from the plan it carries');
  await review.getByRole('button', { name: 'Import as drafts', exact: true }).click();
  await expect(page.locator('.cb-dialog').filter({ hasText: 'Plan imported' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).PlanFileUI.importedRows('plans').length)).toBe(1);
  await page.keyboard.press('Escape');

  // Moved in another tool: the review says the carried plan is what is read.
  const moved = structuredClone(doc); moved.vertices[0][0] += 5000;
  await choose('plans', 'moved.city.json', moved);
  await expect(review).toContainText('differ from the plan it carries');
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();

  // A city model without our plan is refused, pointing to the building editors' Upload footprints.
  const foreign = structuredClone(doc); delete foreign.CityObjects['ugt-plan'];
  await sheet.getByRole('tab', { name: 'Designs', exact: true }).click();
  await choose('designs', 'foreign.city.json', foreign);
  await expect(page.getByRole('alertdialog')).toContainText('carries no plan from this site');
  expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(1);
});
