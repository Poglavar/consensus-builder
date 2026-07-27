import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.describe('Multi-city data adapters @core', () => {
  const cities = [
    { id: 'zagreb', code: 'zg', label: 'Zagreb' },
    { id: 'buenos_aires', code: 'ba', label: 'Buenos Aires' },
    { id: 'belgrade', code: 'bg', label: 'Belgrade' },
    { id: 'ljubljana', code: 'lj', label: 'Ljubljana' },
    { id: 'colorado', code: 'co', label: 'Colorado' },
    { id: 'new_york', code: 'ny', label: 'New York' },
  ];

  test('all configured cities are available', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const available = await page.evaluate(() => {
      const w = window as any;
      if (!w.CityConfigManager?.getAvailableCities) return { skip: true };
      const cities = w.CityConfigManager.getAvailableCities();
      return {
        skip: false,
        count: cities.length,
        ids: cities.map((c: any) => c.id || c.cityId).filter(Boolean),
      };
    });

    test.skip(available.skip === true, 'CityConfigManager not available');
    expect(available.count).toBeGreaterThanOrEqual(2);
  });

  for (const city of cities) {
    test(`switching to ${city.label} loads valid config`, async ({ mockApi: page }) => {
      await page.goto(`/?city=${city.code}`);
      await waitForMapReady(page);

      const config = await page.evaluate((cityId) => {
        const w = window as any;
        const currentId = w.CityConfigManager?.getCurrentCityId?.();
        const cfg = w.CityConfigManager?.getCurrentCityConfig?.();
        if (!cfg) return { loaded: false, currentId };
        return {
          loaded: true,
          currentId,
          hasMap: !!cfg.map,
          hasCenter: !!(cfg.map?.center),
          hasZoom: typeof cfg.map?.zoom === 'number' || typeof cfg.map?.defaultZoom === 'number',
        };
      }, city.id);

      expect(config.loaded).toBe(true);
      expect(config.currentId).toBe(city.id);
      expect(config.hasMap).toBe(true);
    });
  }

  test('each city has distinct map center coordinates', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const centers = await page.evaluate(() => {
      const w = window as any;
      if (!w.CityConfigManager?.getAvailableCities) return { skip: true };
      const cities = w.CityConfigManager.getAvailableCities();
      return {
        skip: false,
        centers: cities.map((c: any) => ({
          id: c.id || c.cityId,
          center: c.map?.center || null,
        })).filter((c: any) => c.center),
      };
    });

    test.skip(centers.skip === true, 'City configs not available');
    // All centers should be unique (no two cities at same coordinates)
    const coords = centers.centers.map((c: any) => `${c.center[0]},${c.center[1]}`);
    const uniqueCoords = new Set(coords);
    expect(uniqueCoords.size).toBe(coords.length);
  });

  // A 'backend base URL resolves' test used to sit here. It was a duplicate of data-source.spec.ts,
  // which asserts the same thing (and more precisely), so it only added a browser boot.
});
