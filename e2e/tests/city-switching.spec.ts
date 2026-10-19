import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, getMapCenter } from '../helpers/app';

test.describe('City switching @core', () => {
  // The fixture stores a city pointer before boot (helpers/fixtures.ts seedCity), which would make
  // this assertion tautological; opt out so the app has to fall back to its own default. With no
  // stored city and no ?city= that is also a first visit, so the world view owns the boot and covers
  // the map (frontend/js/ui/world-entry.js) — the default city loads underneath it.
  test.describe('first visit', () => {
    test.use({ seedCity: null });

    test('default city is New York, under the first-visit world view', async ({ mockApi: page }) => {
      await page.goto('/');
      await page.waitForFunction(() => !!(window as any).WorldEntry && !!(window as any).CityConfigManager);

      const result = await page.evaluate(() => {
        const w = window as any;
        return {
          cityId: w.CityConfigManager.getCurrentCityId(),
          chosen: w.CityConfigManager.wasCityChosenAtBoot(),
          globeOwnsBoot: w.WorldEntry.ownsBoot(),
        };
      });
      expect(result.cityId).toBe('new_york');
      expect(result.chosen).toBe(false);
      expect(result.globeOwnsBoot).toBe(true);
    });
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
