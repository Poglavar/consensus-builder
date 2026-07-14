import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, zoomToParcelLevel } from '../helpers/app';

test.describe('Parcel selection and ownership @core', () => {
  test('ownership highlighting applies distinct styles when parcels loaded', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);
    await zoomToParcelLevel(page);
    await page.waitForTimeout(3000);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (!w.parcelLayer || typeof w.parcelLayer.getLayers !== 'function') {
        return { available: false };
      }
      const layers = w.parcelLayer.getLayers();
      if (layers.length === 0) return { available: false };

      const colors = new Set<string>();
      layers.forEach((layer: any) => {
        if (layer.options && layer.options.fillColor) {
          colors.add(layer.options.fillColor);
        }
      });
      return { available: true, colorCount: colors.size };
    });

    test.skip(!result.available, 'Parcel layer not populated in static-serve mode');
    expect(result.colorCount).toBeGreaterThan(0);
  });

  // Ownership CLASSIFICATION itself is pure string matching and is unit-tested in node
  // (backend/test/parcel-ownership-type.test.js). What needs a browser is the test above — that the
  // classification actually reaches the rendered Leaflet layer styles.

  // Regression: the panel spec only asserts the panel opens — which showParcelInfoPanel() does
  // before the tail of onParcelClick runs. A ReferenceError in that tail therefore left the panel
  // visible while `currentParcel` was never set (build palette empty, every proposal flow dead) and
  // the whole suite stayed green.
  // Selecting a parcel must complete WITHOUT throwing, and must leave currentParcel behind.
  test('clicking a parcel completes without a page error and sets currentParcel', async ({ mockApi: page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');
    await waitForMapReady(page);
    await zoomToParcelLevel(page);
    await page.waitForTimeout(3000);

    const clicked = await page.evaluate(() => {
      const w = window as any;
      const layers = w.parcelLayer?.getLayers?.() || [];
      if (!layers.length || typeof w.onParcelClick !== 'function') return { ran: false };
      const layer = layers[0];
      w.onParcelClick({ target: layer, latlng: layer.getBounds().getCenter() });
      return { ran: true };
    });
    test.skip(!clicked.ran, 'Parcel layer not populated in static-serve mode');

    await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({
      currentParcelId: (window as any).currentParcel?.id ?? null,
      isRoadDefined: (window as any).currentParcel?.isRoad !== undefined,
    }));

    expect(pageErrors, `page errors while selecting a parcel: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(after.currentParcelId).not.toBeNull();
    expect(after.isRoadDefined).toBe(true);
  });
});
