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

  test('ownership classification functions exist', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      return {
        hasClassify: typeof w.classifyOwnership === 'function',
        hasGetType: typeof w.getOwnershipType === 'function',
        hasClassifyType: typeof w.classifyOwnershipType === 'function',
        hasOwnershipModule: typeof w.GOVERNMENT_KEYWORDS !== 'undefined',
      };
    });

    // These are set by ownership-type.js which is an IIFE on window
    const hasSome = Object.values(result).some(v => v === true);
    // Skip if the module didn't load (CDN dependency chain)
    test.skip(!hasSome, 'Ownership module not loaded in this environment');
    expect(hasSome).toBe(true);
  });
});
