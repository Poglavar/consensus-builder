import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, openCity, openParcel, stubBasemapTiles } from '../helpers/runtime';

declare const roadSegments: any[][];
declare const roadSegmentPlacementInProgress: boolean;

for (const kind of ['road', 'track'] as const) {
  test(`${kind} nodes receive clicks through buildings, parks, parcels and cadastral clones`, async ({ mockApi: page }) => {
    await stubBasemapTiles(page);
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator(`.parcel-transport-btn--${kind}`).click();
    if (kind === 'track') await page.locator('#track-speed-confirm-btn').click();
    await expect(page.locator('#road-drawing-controls')).toBeVisible();

    // Exercise real interactive renderers. The observed building and applied park are fixture
    // views; this regression concerns delivery of mouse clicks, rather than authoring their land.
    await page.evaluate(() => {
      const w = window as any;
      const rectangle = (west: number, south: number, east: number, north: number) => ({
        type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
      });
      w.buildingFeaturePool = [{ type: 'Feature', properties: { id: 'drawing-building', object_id: 'drawing-building', source: 'osm-footprints' },
        geometry: rectangle(15.98196, 45.80031, 15.98208, 45.80039) }];
      (document.getElementById('showBuildings') as HTMLInputElement).checked = true;
      w.rebuildBuildingLayerFromPool();
      w.parks = [{ type: 'Feature', properties: { proposalId: 'drawing-park' },
        geometry: rectangle(15.98232, 45.80031, 15.98246, 45.80039) }];
      w.updateParksLayer();
      w.__receivedDrawingClicks = [];
      w.map.on('click', (event: any) => w.__receivedDrawingClicks.push([event.latlng.lng, event.latlng.lat]));
    });

    const nodes = [[15.98202, 45.80035], [15.98239, 45.80035], [15.98239, 45.80010], [15.98202, 45.80010]];
    for (let index = 0; index < nodes.length; index += 1) {
      if (index === 3) await page.evaluate(() => (window as any).__claimsUi.setCadastreView(true));
      const [lng, lat] = nodes[index];
      if (index < 2) {
        // Prove these clicks land on the reported interactive surfaces, not empty map nearby.
        const pane = await page.evaluate(({ lng, lat }) => {
          const w = window as any;
          const point = w.map.latLngToContainerPoint([lat, lng]);
          const rect = w.map.getContainer().getBoundingClientRect();
          const target = document.elementFromPoint(rect.left + point.x, rect.top + point.y);
          const layer: any = Object.values(w.map._targets).find((layer: any) => layer._path?.contains(target));
          return layer?.options?.pane;
        }, { lng, lat });
        expect(pane).toBe(index === 0 ? 'observedBuildings' : 'parksPane');
      }
      await clickMapPoint(page, lng, lat);
      await expect.poll(() => page.evaluate(() => roadSegments.flat().length)).toBe(index + 1);
      await expect.poll(() => page.evaluate(() => roadSegmentPlacementInProgress)).toBe(false);
    }
    expect(await page.evaluate(() => (window as any).__receivedDrawingClicks.length)).toBe(4);
    await expect(page.locator('#road-length')).not.toHaveText('0 m');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard the drawing', exact: true }).click();
    await expect(page.locator('#road-drawing-controls')).toBeHidden();
  });
}
