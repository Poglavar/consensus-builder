// Demolitions derived from the applied designs' land against the buildings shown
// (docs/source-loading-plan.md F4): a park razes the building on its parcel, and switching the
// building sources redraws that against the other source's building, without a reload.
import { createRequire } from 'node:module';
import path from 'node:path';
import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, PARCEL_GEOMETRY } from '../helpers/runtime';
import { mockFootprintCells } from '../helpers/mocks/building-data';

const turf = createRequire(path.resolve(__dirname, '../../backend/package.json'))('@turf/turf');

// A small building in the middle of the fixture parcel, as each survey has it.
const [x, y] = turf.pointOnFeature(turf.feature(PARCEL_GEOMETRY as any)).geometry.coordinates;
const square = (d: number) => ({ type: 'Polygon', coordinates: [[[x - d, y - d], [x + d, y - d], [x + d, y + d], [x - d, y + d], [x - d, y - d]]] });

test('a park razes the building on its ground, and a source switch derives that again over the other survey', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(() => { (window as any).BuildingCellLoader.clear(); (window as any).__noReload = true; });
  await mockFootprintCells(page, body => body.source === 'gdi-3d' ? [{ id: 'gdi-1', geometry: square(0.00002), height_m: 9 }]
    : body.source === 'osm' ? [{ id: 'w7', geometry: square(0.000015) }] : []);
  await createSpace(page, 'park');
  const razed = () => page.evaluate(() => (window as any).DemolitionIndex.records().map((record: any) => [record.id, !!record.remainder]));
  await expect.poll(razed).toEqual([['gdi-3d:gdi-1', false]]);

  // OpenStreetMap in use instead of GDI: the same park razes OpenStreetMap's copy of the building.
  await page.evaluate(() => {
    const w = window as any;
    const list = w.CityConfigManager.getBuildingSources().map((entry: any) => ({ ...entry, use: entry.id === 'osm' }));
    w.SourceList.save(w.CityConfigManager.getCurrentCityId(), list, w);
  });
  await expect.poll(razed).toEqual([['osm:w7', false]]);
  expect(await page.evaluate(() => (window as any).__noReload)).toBe(true);
  // Every building the pool holds now is OpenStreetMap's.
  await expect.poll(() => page.evaluate(() => [...new Set(((window as any).buildingFeaturePool || []).map((f: any) => f.properties.source))])).not.toContain('gdi-3d');
});
