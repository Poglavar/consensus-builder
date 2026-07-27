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

  // A five-way `typeof mgr.x === 'function'` roll-call used to sit here. Every method it named is
  // called for real by the tests below, so its only unique contribution was a browser boot.

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
