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

    test('first-visit search guides keyboard selection and restores focus on dismiss', async ({ mockApi: page }) => {
      await page.goto('/?reduceMotion=1');
      const world = page.locator('#world-view');
      const search = world.getByRole('combobox', { name: 'Choose where to design' });
      await expect(search).toBeVisible({ timeout: 45_000 });
      await search.fill('Belgrade');
      await page.evaluate(() => (window as any).ParcelGroundFallback.onGroundUnavailable({ city: 'new_york', error: new Error('Register unavailable') }));
      await expect(page.locator('.ground-fallback-dialog')).toHaveCount(0);
      await expect(search).toBeFocused();
      await search.press('Enter');
      const open = world.getByRole('button', { name: 'Open Belgrade' });
      await expect(open).toBeFocused({ timeout: 15_000 });
      await page.keyboard.press('Escape');
      await expect(search).toBeFocused();
      await expect(world.locator('.world-popup')).toBeHidden();
    });

    test('first city choice opens its 2D map without looking up the latest design', async ({ mockApi: page }) => {
      const latestRequests: string[] = [];
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname.endsWith('/designs') && url.searchParams.get('limit') === '1'
            && /^(zagreb|zg)$/i.test(url.searchParams.get('city') || '')) latestRequests.push(request.url());
      });
      await page.goto('/?reduceMotion=1');
      const world = page.locator('#world-view');
      const search = world.getByRole('combobox', { name: 'Choose where to design' });
      await expect(search).toBeVisible({ timeout: 45_000 });
      await search.fill('Zagreb');
      await search.press('Enter');
      await world.getByRole('button', { name: 'Open Zagreb' }).click();
      await waitForMapReady(page);
      await expect(world).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => (window as any).CityConfigManager?.getCurrentCityId())).toBe('zagreb');
      await expect.poll(() => page.evaluate(() => (window as any).isThreeModeActive?.() ?? false)).toBe(false);
      await expect.poll(() => page.evaluate(() => (window as any).map?.getZoom())).toBe(19);
      await expect(page.locator('#design-start-button')).toBeVisible();
      await expect(page.locator('#design-start-button')).toHaveAccessibleName('Design');
      expect(latestRequests).toEqual([]);
    });
  });

  // A five-way `typeof mgr.x === 'function'` roll-call used to sit here. Every method it named is
  // called for real by the tests below, so its only unique contribution was a browser boot.

  // A page holds only its own city's configuration, so a stored city takes effect on the next load.
  test('a stored city keeps this page in its city and opens on the next load', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const cityId = await page.evaluate(() => {
      const w = window as any;
      w.CityConfigManager.setStoredCityId('colorado');
      return w.CityConfigManager.getCurrentCityId();
    });
    expect(cityId).toBe('new_york');

    await page.goto('/');
    await waitForMapReady(page);
    expect(await page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId())).toBe('colorado');
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
      w.CityConfigManager.setStoredCityId('belgrade');
    });

    const stored = await page.evaluate(() => {
      const w = window as any;
      return w.PersistentStorage?.getItem?.('cb_current_city') ?? null;
    });

    expect(stored).toBe('belgrade');
  });
});
