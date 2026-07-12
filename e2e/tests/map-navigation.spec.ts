import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, getMapZoom, getMapCenter, panMap, zoomToParcelLevel } from '../helpers/app';

test.describe('Map navigation @core', () => {
  test('map renders with basemap tiles', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    // At least some tile images should be loaded
    const tileCount = await page.evaluate(() => {
      return document.querySelectorAll('.leaflet-tile-pane img').length;
    });
    expect(tileCount).toBeGreaterThan(0);
  });

  test('zoom in programmatically increases zoom level', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    // Start from a mid-range zoom to ensure room to zoom in. animate:false everywhere —
    // animated multi-level zooms run on requestAnimationFrame, and a setZoom issued while a
    // previous animation is still running is silently ignored by Leaflet (persistent red).
    await page.evaluate(() => { (window as any).map?.setZoom(14, { animate: false }); });
    await expect.poll(() => getMapZoom(page), { timeout: 10_000 }).toBe(14);

    await page.evaluate(() => {
      const w = window as any;
      w.map?.setZoom(w.map.getZoom() + 1, { animate: false });
    });
    await expect.poll(() => getMapZoom(page), { timeout: 10_000 }).toBeGreaterThan(14);
  });

  test('zoom out programmatically decreases zoom level', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    // First zoom in so we have room to zoom out (see polling note in the zoom-in test).
    await page.evaluate(() => { (window as any).map?.setZoom(15, { animate: false }); });
    await expect.poll(() => getMapZoom(page), { timeout: 10_000 }).toBe(15);

    await page.evaluate(() => {
      const w = window as any;
      w.map?.setZoom(w.map.getZoom() - 1, { animate: false });
    });
    await expect.poll(() => getMapZoom(page), { timeout: 10_000 }).toBeLessThan(15);
  });

  test('dragging pans the map', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const [initLat, initLng] = await getMapCenter(page);
    await panMap(page, 200, 0);
    const [newLat, newLng] = await getMapCenter(page);

    // Longitude should change when panning horizontally
    expect(newLng).not.toBeCloseTo(initLng, 3);
  });

  test('zooming to level ≥17 triggers parcel fetch', async ({ mockApi: page }) => {
    let parcelFetchTriggered = false;
    page.on('request', (req) => {
      if (req.url().includes('/parcels') || req.url().includes('parcels')) {
        parcelFetchTriggered = true;
      }
    });

    await page.goto('/');
    await waitForMapReady(page);
    await zoomToParcelLevel(page);
    await page.waitForTimeout(2000);

    expect(parcelFetchTriggered).toBe(true);
  });
});
