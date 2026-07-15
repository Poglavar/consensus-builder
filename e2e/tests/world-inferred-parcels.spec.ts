// Purpose: verify the global coordinate deep link loads provisional inferred parcels into the normal map workflow.
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, waitForParcelsLoaded } from '../helpers/app';

test.describe('Anywhere inferred parcels @core', () => {
  test('loads, styles, and labels provisional viewport parcels', async ({ mockApi: page }) => {
    const inferenceRequests: string[] = [];
    await page.route('**/parcels/inferred**', async (route) => {
      inferenceRequests.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            properties: {
              parcelId: 'AI-test-parcel',
              BROJ_CESTICE: 'AI-test-parcel',
              provenance: 'inferred',
              planningStatus: 'provisional',
              authoritative: false,
              confidence: 0.87,
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [15.968, 45.798],
                [15.972, 45.798],
                [15.972, 45.802],
                [15.968, 45.802],
                [15.968, 45.798],
              ]],
            },
          }],
        }),
      });
    });

    await page.goto('/?city=world&lat=45.8&lng=15.97&zoom=18');
    await waitForMapReady(page);
    await waitForParcelsLoaded(page);

    const state = await page.evaluate(() => {
      const w = window as any;
      const center = w.map.getCenter();
      const layer = w.parcelLayer.getLayers()[0];
      const dashArray = layer.options?.dashArray;
      layer.fire('click', { target: layer });
      return {
        cityId: w.CityConfigManager.getCurrentCityId(),
        center: [center.lat, center.lng],
        zoom: w.map.getZoom(),
        parcelId: layer.feature?.properties?.parcelId,
        provenance: layer.feature?.properties?.provenance,
        dashArray,
      };
    });

    expect(state.cityId).toBe('world');
    expect(state.center[0]).toBeCloseTo(45.8, 3);
    expect(state.center[1]).toBeCloseTo(15.97, 3);
    expect(state.zoom).toBe(18);
    expect(state.parcelId).toBe('AI-test-parcel');
    expect(state.provenance).toBe('inferred');
    expect(state.dashArray).toBe('6 5');
    expect(inferenceRequests.length).toBeGreaterThan(0);
    expect(inferenceRequests[0]).toContain('zoom=18');

    await expect(page.locator('#anywhere-location-controls')).toBeVisible();
    await expect(page.locator('#anywhere-latitude')).toHaveValue('45.8');
    await expect(page.locator('#anywhere-longitude')).toHaveValue('15.97');
    await expect(page.locator('#info-content')).toContainText('provisional');
    await expect(page.locator('#info-content')).toContainText('87%');
  });
});
