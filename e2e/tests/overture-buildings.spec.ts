import { expect } from '@playwright/test';
import { test } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { mockOvertureTiles, TestBuilding } from '../helpers/mocks/overture-tiles';

/**
 * Buildings read in the browser from Overture's public tiles (js/overture-tiles.js through
 * js/building-source-client.js): a city without its own survey fills its footprint pool from the
 * tiles and never asks our backend, and Bogotá asks its cadastre first and falls back to the tiles
 * when the cadastre has nothing there. The tiles come from an offline archive (helpers/mocks).
 */

// Two buildings in central Bogotá: one drawn by OpenStreetMap (keeps its OSM id), one by Microsoft.
const square = (lng: number, lat: number, d = 0.0001): Array<[number, number]> =>
  [[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]];
const BUILDINGS: TestBuilding[] = [
  { id: 'gers-osm', osmId: 'w24518461', ring: square(-74.0823, 4.6104), height: 21 },
  { id: 'gers-ml', ring: square(-74.0820, 4.6106), floors: 4 }
];
const VIEW = 'at=4.6105,-74.0822,18&lang=en&reduceMotion=1';

const poolIds = (page: any) => page.evaluate(() =>
  ((window as any).buildingFeaturePool || []).map((f: any) => String(f.properties?.id ?? f.id)).sort());

test.describe('Overture buildings in the browser', () => {
  test('a city without its own survey fills its buildings from the tiles, not from our server', async ({ mockApi: page }) => {
    const tiles = await mockOvertureTiles(page, BUILDINGS);
    const backendFootprints: string[] = [];
    page.on('request', request => { if (request.url().endsWith('/buildings/footprints')) backendFootprints.push(request.url()); });
    await page.goto(`/?city=explore&${VIEW}`);
    await waitForMapReady(page);
    expect(await page.evaluate(() => (window as any).CityConfigManager.getCurrentCityConfig().buildings.source)).toBe('overture-tiles');

    await page.evaluate(() => (window as any).ensureBuildingFootprintsForBounds((window as any).map.getBounds()));
    await expect.poll(() => poolIds(page)).toEqual(['gers-ml', 'w24518461']);
    const heights = await page.evaluate(() => Object.fromEntries(((window as any).buildingFeaturePool || [])
      .map((f: any) => [f.properties.id, [f.properties.height_m, f.properties.floors]])));
    expect(heights).toEqual({ w24518461: [21, null], 'gers-ml': [null, 4] });
    expect(tiles.catalogue).toBeGreaterThan(0);
    expect(tiles.ranges.length).toBeGreaterThan(0);
    expect(backendFootprints).toEqual([]);

    // The 3D answer is extruded in the browser by the shared rule: measured, storeys × 3 m.
    const near = await page.evaluate(() => (window as any).BuildingSourceClient.request('/buildings/near',
      { geometry: { type: 'Point', coordinates: [-74.0822, 4.6105] }, buffer_meters: 100 }));
    expect(near.source).toBe('overture-tiles-3d');
    expect(Object.fromEntries(near.buildings.map((b: any) => [b.object_id, b.z_max]))).toEqual({ w24518461: 21, 'gers-ml': 12 });
  });

  test("Bogotá reads its cadastre's buildings, and Overture's where the cadastre has none", async ({ mockApi: page }) => {
    const tiles = await mockOvertureTiles(page, BUILDINGS);
    let cadastre: Array<Record<string, unknown>> = [];
    const asked: Array<Record<string, unknown>> = [];
    await page.route('**/buildings/footprints', route => {
      asked.push(route.request().postDataJSON());
      return route.fulfill({ json: { supported: true, footprints: cadastre, count: cadastre.length, truncated: false, source: 'custom-footprints' } });
    });
    await page.goto(`/?city=bogota&${VIEW}`);
    await waitForMapReady(page);

    cadastre = [{ id: 'CUSTOM-B-58c2275a9021877e969e-330327', geometry: { type: 'Polygon', coordinates: [square(-74.0823, 4.6104)] }, height_m: null, floors: 3 }];
    await page.evaluate(() => (window as any).ensureBuildingFootprintsForBounds((window as any).map.getBounds()));
    await expect.poll(() => poolIds(page)).toEqual(['CUSTOM-B-58c2275a9021877e969e-330327']);
    expect(asked[0]).toMatchObject({ city: 'bogota', source: expect.stringMatching(/^building\./) });
    expect(tiles.ranges).toEqual([]);

    // Somewhere the cadastre has nothing: the same request falls back to the tiles.
    cadastre = [];
    const before = tiles.ranges.length;
    const fallback = await page.evaluate(() => (window as any).BuildingSourceClient.request('/buildings/footprints',
      { geometry: { type: 'Polygon', coordinates: [[[-74.083, 4.610], [-74.081, 4.610], [-74.081, 4.611], [-74.083, 4.611], [-74.083, 4.610]]] },
        city: 'bogota', source: (window as any).CityConfigManager.getBuildingSourceId() }));
    expect(fallback.source).toBe('overture-tiles-footprints');
    expect(fallback.footprints.map((f: any) => f.id).sort()).toEqual(['gers-ml', 'w24518461']);
    expect(tiles.ranges.length).toBeGreaterThan(before);
  });
});
