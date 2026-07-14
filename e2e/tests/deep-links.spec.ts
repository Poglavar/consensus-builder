import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.describe('Deep link and URL parameters @core', () => {
  test('?city=ba sets Buenos Aires as current city', async ({ mockApi: page }) => {
    await page.goto('/?city=ba');
    await waitForMapReady(page);

    const cityId = await page.evaluate(() => {
      const w = window as any;
      return w.CityConfigManager?.getCurrentCityId?.() ?? '';
    });

    expect(cityId).toBe('buenos_aires');
  });

  test('?city=bg sets Belgrade as current city', async ({ mockApi: page }) => {
    await page.goto('/?city=bg');
    await waitForMapReady(page);

    const cityId = await page.evaluate(() => {
      const w = window as any;
      return w.CityConfigManager?.getCurrentCityId?.() ?? '';
    });

    expect(cityId).toBe('belgrade');
  });

  test('?city=zg sets Zagreb as current city', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);

    const cityId = await page.evaluate(() => {
      const w = window as any;
      return w.CityConfigManager?.getCurrentCityId?.() ?? '';
    });

    expect(cityId).toBe('zagreb');
  });

  test('?city=lj sets Ljubljana as current city', async ({ mockApi: page }) => {
    await page.goto('/?city=lj');
    await waitForMapReady(page);

    const cityId = await page.evaluate(() => {
      const w = window as any;
      return w.CityConfigManager?.getCurrentCityId?.() ?? '';
    });

    expect(cityId).toBe('ljubljana');
  });

  test('invalid ?city param falls back to default', async ({ mockApi: page }) => {
    await page.goto('/?city=invalid_xyz');
    await waitForMapReady(page);

    const cityId = await page.evaluate(() => {
      const w = window as any;
      return w.CityConfigManager?.getCurrentCityId?.() ?? '';
    });

    // Should fall back to default (Zagreb) or previously stored
    expect(cityId.length).toBeGreaterThan(0);
  });

  // A 'skipParcelFetchUntilProposalLoaded flag is accessible' test used to sit here. It set a
  // property on `window` and then read it back — it tested that JavaScript objects hold values, not
  // that the app does anything, and it booted a browser to do it.

  test('?city param overrides stored city preference', async ({ mockApi: page }) => {
    // First set a city via storage
    await page.goto('/');
    await waitForMapReady(page);
    await page.evaluate(() => {
      const w = window as any;
      w.CityConfigManager?.setCurrentCityId?.('belgrade');
    });

    // Now navigate with ?city=ba — should override stored belgrade
    await page.goto('/?city=ba');
    await waitForMapReady(page);

    const cityId = await page.evaluate(() => {
      const w = window as any;
      return w.CityConfigManager?.getCurrentCityId?.() ?? '';
    });

    expect(cityId).toBe('buenos_aires');
  });
});
