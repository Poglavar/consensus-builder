import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, getMapCenter } from '../helpers/app';

test.describe('City switching @core', () => {
  test('default city is New York', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const cityId = await page.evaluate(() => {
      const w = window as any;
      return w.CityConfigManager?.getCurrentCityId?.() ?? '';
    });
    expect(cityId).toBe('new_york');
  });

  test('CityConfigManager exposes city switching API', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const api = await page.evaluate(() => {
      const w = window as any;
      const mgr = w.CityConfigManager;
      return {
        hasGetCurrentCityId: typeof mgr?.getCurrentCityId === 'function',
        hasSetCurrentCityId: typeof mgr?.setCurrentCityId === 'function',
        hasSwitchCity: typeof mgr?.switchCity === 'function',
        hasGetCurrentCityConfig: typeof mgr?.getCurrentCityConfig === 'function',
        hasGetAvailableCities: typeof mgr?.getAvailableCities === 'function',
      };
    });

    expect(api.hasGetCurrentCityId).toBe(true);
    expect(api.hasSetCurrentCityId).toBe(true);
    expect(api.hasSwitchCity).toBe(true);
    expect(api.hasGetCurrentCityConfig).toBe(true);
    expect(api.hasGetAvailableCities).toBe(true);
  });

  test('setCurrentCityId updates internal city and dispatches event', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      let eventFired = false;
      let eventCityId = '';
      window.addEventListener('cityChanged', (e: any) => {
        eventFired = true;
        eventCityId = e.detail?.cityId ?? '';
      }, { once: true });

      w.CityConfigManager.setCurrentCityId('colorado');
      return {
        newCityId: w.CityConfigManager.getCurrentCityId(),
        eventFired,
        eventCityId,
      };
    });

    expect(result.newCityId).toBe('colorado');
    expect(result.eventFired).toBe(true);
    expect(result.eventCityId).toBe('colorado');
  });

  test('city config contains expected properties', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const config = await page.evaluate(() => {
      const w = window as any;
      const cfg = w.CityConfigManager.getCurrentCityConfig();
      return {
        hasMap: 'map' in (cfg || {}),
        hasProjection: 'projection' in (cfg || {}),
        hasName: typeof cfg?.name === 'string' || typeof cfg?.label === 'string',
      };
    });

    expect(config.hasMap).toBe(true);
  });

  test('city choice persists via PersistentStorage', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    await page.evaluate(() => {
      const w = window as any;
      w.CityConfigManager.setCurrentCityId('belgrade');
    });

    const stored = await page.evaluate(() => {
      const w = window as any;
      return w.PersistentStorage?.getItem?.('cb_current_city') ?? null;
    });

    expect(stored).toBe('belgrade');
  });
});
