// CityJSON beside our own files (js/city-json-export.js): a saved Freeform building downloads from its
// design card as a CityJSON 2.0 file with the building, its design group and the plan file inside.
import { readFileSync } from 'node:fs';
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, placeFreeformBuilding, showProposal, stubBasemapTiles } from '../helpers/runtime';

test('Download design offers CityJSON beside the editable plan and GeoJSON', async ({ mockApi: page }) => {
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
});
